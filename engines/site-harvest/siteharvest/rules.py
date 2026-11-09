"""Finite declarative extraction rules, evaluated only on registered saved HTML.

Selectors are a small XPath subset, not arbitrary XPath, Python or JavaScript.
Trial output never changes source state, original evidence, or adopted rules.
"""
import hashlib
import json
import re
from pathlib import Path
from urllib.parse import urlsplit

import lxml.html

from . import util

TOKEN = r'[A-Za-z_][A-Za-z0-9_-]*'
STEP = re.compile(r'(?:\*|%s)(?:\[@%s(?:=[\'\"][A-Za-z0-9 _:/.,#?=&;+-]*[\'\"])?\])?' % (TOKEN, TOKEN))


def has_expectation(expected):
    return 'recordCount' in expected or bool(expected.get('containsText') or expected.get('fieldValues') or expected.get('paginationUrls'))


def configured_blocks(node, base):
    """Explicit containers retain tables even when generic layout heuristics reject them."""
    from . import extract
    tag = extract.localname(node)
    if tag == 'table':
        rows = extract.table_rows(node)
        return [{'kind': 'table', 'rows': rows, 'hidden': extract.is_hidden(node)}] if rows else []
    if tag in {'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'ul', 'ol', 'dl', 'blockquote',
               'pre', 'img', 'iframe', 'video', 'audio', 'form'}:
        return extract.rich_blocks(node, base)
    if tag in {'script', 'style', 'noscript', 'template'}:
        return []
    blocks = []
    if node.text and node.text.strip():
        blocks.append({'kind': 'p', 'text': util.norm_text(node.text), 'hidden': extract.is_hidden(node)})
    for child in node:
        if isinstance(child.tag, str):
            blocks.extend(configured_blocks(child, base))
        if child.tail and child.tail.strip():
            blocks.append({'kind': 'p', 'text': util.norm_text(child.tail), 'hidden': extract.is_hidden(node)})
    return blocks


def selector(value, relative=False):
    """Support //tag[@attr='value']/tag and .//tag paths, no functions/unions."""
    if not isinstance(value, str) or len(value) > 500:
        raise ValueError('selector must be a string of at most 500 characters')
    prefix = './/' if relative else '//'
    if not value.startswith(prefix):
        raise ValueError('selector must start with ' + prefix)
    tail = value[len(prefix):]
    if not tail or any(not STEP.fullmatch(part) for part in tail.split('/')):
        raise ValueError('selector outside supported finite XPath subset')
    return value


def validate(rules):
    allowed = {'schemaVersion', 'version', 'baseVersion', 'issueEvidence', 'appliesTo', 'container', 'fields',
               'pagination', 'assets', 'relations'}
    if not isinstance(rules, dict) or set(rules) - allowed or rules.get('schemaVersion') != 1:
        raise ValueError('invalid rules schema')
    if not re.fullmatch(r'[A-Za-z0-9_.-]{1,100}', rules.get('version', '')):
        raise ValueError('invalid rule version')
    applicability = rules.get('appliesTo', {})
    if not isinstance(applicability, dict) or set(applicability) - {'hosts', 'pathPrefixes', 'languages', 'requiredSelector'}:
        raise ValueError('invalid applicability')
    for name in ('hosts', 'pathPrefixes', 'languages'):
        values = applicability.get(name, [])
        if not isinstance(values, list) or len(values) > 100 or any(not isinstance(v, str) or len(v) > 500 for v in values):
            raise ValueError('invalid applicability ' + name)
    if applicability.get('requiredSelector'):
        selector(applicability['requiredSelector'])
    selector(rules.get('container'))
    fields = rules.get('fields', {})
    if not isinstance(fields, dict) or len(fields) > 32:
        raise ValueError('fields must contain at most 32 entries')
    for name, field in fields.items():
        if not re.fullmatch(TOKEN, name) or not isinstance(field, dict) or set(field) - {'selector', 'attribute', 'multiple', 'required'}:
            raise ValueError('invalid field configuration')
        selector(field.get('selector'), relative=True)
        if field.get('attribute') and not re.fullmatch(TOKEN, field['attribute']):
            raise ValueError('invalid field attribute')
        for boolean in ('multiple', 'required'):
            if boolean in field and not isinstance(field[boolean], bool):
                raise ValueError('invalid field boolean')
    for kind in ('pagination', 'assets', 'relations'):
        config = rules.get(kind)
        if config is not None:
            if not isinstance(config, dict) or set(config) - {'selector', 'attribute'}:
                raise ValueError('invalid ' + kind)
            selector(config.get('selector'))
            if not re.fullmatch(TOKEN, config.get('attribute', 'href')):
                raise ValueError('invalid link attribute')
    return rules


def apply(raw, url, rules):
    doc = lxml.html.document_fromstring(raw, base_url=url)
    applicability = rules.get('appliesTo', {})
    parts = urlsplit(url)
    language = (doc.get('lang') or '').lower().replace('_', '-')
    matches = ((not applicability.get('hosts') or parts.hostname in applicability['hosts']) and
               (not applicability.get('pathPrefixes') or any(parts.path.startswith(p) for p in applicability['pathPrefixes'])) and
               (not applicability.get('languages') or language in applicability['languages']) and
               (not applicability.get('requiredSelector') or bool(doc.xpath(applicability['requiredSelector']))))
    if not matches:
        return {'applicable': False, 'issues': ['rule applicability mismatch'], 'records': [], 'links': {}}
    containers = doc.xpath(rules['container'])
    if len(containers) > 10000:
        raise ValueError('container count exceeds 10000; no truncated result accepted')
    records, issues = [], []
    if not containers:
        issues.append('container matched no nodes')
    for index, container in enumerate(containers):
        fields = {}
        for name, field in rules.get('fields', {}).items():
            values = []
            for node in container.xpath(field['selector']):
                value = node.get(field['attribute'], '') if field.get('attribute') else util.norm_text(node.text_content())
                if value:
                    values.append(value)
            fields[name] = values if field.get('multiple') else (values[0] if values else '')
            if not field.get('multiple') and len(values) > 1:
                issues.append('record %d field %s ambiguous: %d values' % (index, name, len(values)))
            if field.get('required') and not values:
                issues.append('record %d required field %s missing' % (index, name))
        # Preserve container HTML and complete text; no candidate abbreviation is evidence.
        records.append({'index': index, 'fields': fields, 'text': util.norm_text(container.text_content()),
                        'html': lxml.html.tostring(container, encoding='unicode')})
    links = {}
    for kind in ('pagination', 'assets', 'relations'):
        config = rules.get(kind)
        if config:
            values = [util.resolve_url(url, n.get(config.get('attribute', 'href'), '')) for n in doc.xpath(config['selector'])]
            links[kind] = list(dict.fromkeys(v for v in values if v))
    return {'applicable': True, 'issues': issues, 'records': records, 'links': links,
            'truncated': False, 'paginationExhausted': None}


def trial(request, state, workspace):
    rules = validate(request.get('rules'))
    trial_id = request.get('trialId')
    if not isinstance(trial_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', trial_id):
        raise ValueError('trialId must be a stable safe identifier')
    ids = request.get('sampleIds')
    if not isinstance(ids, list) or not 1 <= len(ids) <= 200 or len(set(ids)) != len(ids):
        raise ValueError('sampleIds must name 1..200 unique saved objects')
    expectations = request.get('expectations', {})
    if not isinstance(expectations, dict) or set(expectations) - set(ids):
        raise ValueError('expectations must reference selected sampleIds')
    target = workspace / '.work/rule-trials' / trial_id
    if target.exists():
        raise ValueError('trial output exists; choose a new trialId')
    by_id = {r['id']: r for r in state['urls'].values()}
    samples = []
    # Read/validate all inputs before creating any output.
    for sample_id in ids:
        record = by_id.get(sample_id)
        if not record or not record.get('rawFile'):
            raise ValueError('sample has no registered original: ' + str(sample_id))
        raw_path = workspace / record['rawFile']
        if not raw_path.resolve().is_relative_to(workspace) or not raw_path.is_file():
            raise ValueError('sample original missing or escaped workspace')
        raw_bytes = raw_path.read_bytes()
        if len(raw_bytes) > 8 * 1024 * 1024:
            raise ValueError('sample exceeds 8MiB; no silent truncation')
        expected = expectations.get(sample_id, {})
        if not isinstance(expected, dict) or set(expected) - {'recordCount', 'containsText', 'fieldValues', 'paginationUrls'}:
            raise ValueError('invalid fixed expectation')
        if 'recordCount' in expected and (isinstance(expected['recordCount'], bool) or not isinstance(expected['recordCount'], int) or expected['recordCount'] < 0):
            raise ValueError('recordCount must be a nonnegative integer')
        if any(not isinstance(expected.get(k, []), list) or any(not isinstance(v, str) for v in expected.get(k, [])) for k in ('containsText', 'paginationUrls')):
            raise ValueError('text and pagination expectations must be string arrays')
        if not isinstance(expected.get('fieldValues', {}), dict):
            raise ValueError('fieldValues expectation must be an object')
        samples.append((sample_id, record, raw_bytes, expected))
    target.mkdir(parents=True)
    util.write_json(str(target / 'rules.json'), rules)
    util.write_json(str(target / 'expectations.json'), expectations)
    results = []
    for sample_id, record, raw_bytes, expected in samples:
        result = apply(raw_bytes.decode('utf-8'), record.get('finalUrl') or record['url'], rules)
        differences = list(result['issues'])
        if 'recordCount' in expected and len(result['records']) != expected['recordCount']:
            differences.append('recordCount expected %d actual %d' % (expected['recordCount'], len(result['records'])))
        extracted_text = '\n'.join(r['text'] for r in result['records'])
        for value in expected.get('containsText', []):
            if value not in extracted_text:
                differences.append('required text missing: ' + value)
        for name, values in expected.get('fieldValues', {}).items():
            if [r['fields'].get(name) for r in result['records']] != values:
                differences.append('field values differ: ' + name)
        if 'paginationUrls' in expected and result['links'].get('pagination', []) != expected['paginationUrls']:
            differences.append('pagination URLs differ')
        evidence = {'path': record['rawFile'], 'sha256': hashlib.sha256(raw_bytes).hexdigest(),
                    'bytes': len(raw_bytes), 'layer': 'saved-html', 'url': record['url']}
        item = {'sampleId': sample_id, 'source': evidence, 'result': result, 'differences': differences,
                'status': 'failed' if differences else 'passed' if has_expectation(expected) else 'unverified'}
        util.write_json(str(target / (sample_id + '.json')), item)
        results.append({'sampleId': sample_id, 'status': item['status'], 'differences': differences,
                        'source': evidence,
                        'sha256': hashlib.sha256((target / (sample_id + '.json')).read_bytes()).hexdigest(),
                        'artifact': (target / (sample_id + '.json')).relative_to(workspace).as_posix()})
    report = {'ruleVersion': rules['version'], 'baseVersion': rules.get('baseVersion'), 'trialId': trial_id,
              'status': 'failed' if any(r['status'] == 'failed' for r in results) else
                        'passed' if all(r['status'] == 'passed' for r in results) else 'unverified',
              'samples': results, 'adopted': False, 'scopeCoverage': 'unverified',
              'rulesSha256': hashlib.sha256((target / 'rules.json').read_bytes()).hexdigest(),
              'expectationsSha256': hashlib.sha256((target / 'expectations.json').read_bytes()).hexdigest(),
              'boundary': 'Fixed sample comparisons only. No source state, original evidence or acceptance criteria changed.'}
    util.write_json(str(target / 'report.json'), report)
    return {'trial': report, 'report': (target / 'report.json').relative_to(workspace).as_posix(),
            'reportSha256': hashlib.sha256((target / 'report.json').read_bytes()).hexdigest()}


def adopt(request, state, workspace):
    """Apply a bound passing trial to its exact originals; keep previous extracts."""
    from . import cli, dataset, extract, naming, render, verify
    trial_id = request.get('trialId', '')
    if not isinstance(trial_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', trial_id):
        raise ValueError('invalid trialId')
    target = workspace / '.work/rule-trials' / trial_id
    report_path = target / 'report.json'
    expected_hash = request.get('expectedTrialHash')
    if not re.fullmatch(r'[a-f0-9]{64}', expected_hash or '') or not report_path.is_file():
        raise ValueError('expectedTrialHash must bind an existing trial report')
    if hashlib.sha256(report_path.read_bytes()).hexdigest() != expected_hash:
        raise ValueError('trial report hash mismatch')
    report = json.loads(report_path.read_text())
    if report.get('status') != 'passed' or not report.get('samples'):
        raise ValueError('only passing fixed-expectation trials can be applied')
    for name, hash_key in [('rules.json', 'rulesSha256'), ('expectations.json', 'expectationsSha256')]:
        if hashlib.sha256((target / name).read_bytes()).hexdigest() != report.get(hash_key):
            raise ValueError('trial input changed: ' + name)
    rules = validate(json.loads((target / 'rules.json').read_text()))
    expectations = json.loads((target / 'expectations.json').read_text())
    adoption = target / 'adoption'
    if adoption.exists():
        raise ValueError('trial already applied or interrupted; inspect adoption receipt before continuing')
    updates = []
    by_id = {r['id']: r for r in state['urls'].values()}
    for item in report['samples']:
        sample_id = item['sampleId']
        record = by_id.get(sample_id)
        if not record or record.get('action') != 'keep' or not has_expectation(expectations.get(sample_id, {})):
            raise ValueError('apply requires kept samples with fixed expectations')
        sample_path = workspace / item['artifact']
        if not sample_path.resolve().is_relative_to(target) or hashlib.sha256(sample_path.read_bytes()).hexdigest() != item['sha256']:
            raise ValueError('trial sample result changed')
        raw_path = workspace / record['rawFile']
        raw = raw_path.read_bytes()
        if hashlib.sha256(raw).hexdigest() != item['source']['sha256']:
            raise ValueError('original changed since trial: ' + sample_id)
        # Recompute deterministic extraction; trial output is never executable input.
        url = record.get('finalUrl') or record['url']
        matched = apply(raw.decode('utf-8'), url, rules)
        if not matched['applicable'] or matched['issues']:
            raise ValueError('rule no longer matches fixed sample')
        data = extract.extract_page(raw.decode('utf-8'), url)
        if not data:
            raise ValueError('base extraction failed')
        blocks = []
        for container in matched['records']:
            node = lxml.html.fromstring(container['html'], base_url=url)
            blocks.extend(configured_blocks(node, data['base']))
        data['blocks'] = extract.clean_blocks(blocks)
        data['words'] = util.text_len('\n'.join(r['text'] for r in matched['records']))
        data['tables'] = [b for b in data['blocks'] if b.get('kind') == 'table']
        data['headings'] = [{'level': b['level'], 'text': b['text']} for b in data['blocks'] if b.get('kind') == 'heading']
        data['h1'] = next((h['text'] for h in data['headings'] if h['level'] == 1), '')
        if len(matched['records']) == 1:
            fields = matched['records'][0]['fields']
            for field in ('title', 'description', 'canonical'):
                if field in fields and isinstance(fields[field], str):
                    data[field] = fields[field]
        data['ruleExtraction'] = {'version': rules['version'], 'trialId': trial_id,
                                  'trialReportSha256': expected_hash, 'records': matched['records'], 'links': matched['links']}
        updates.append((sample_id, record, data))
    adoption.mkdir(parents=True)
    util.write_json(str(adoption / 'previous-state.json'), state)
    for sample_id, _record, _data in updates:
        old = workspace / '.work/extract' / (sample_id + '.json')
        if old.exists():
            (adoption / (sample_id + '.previous.json')).write_bytes(old.read_bytes())
    for sample_id, _record, data in updates:
        util.write_json(str(adoption / (sample_id + '.applied.json')), data)
    receipt = {'trialId': trial_id, 'ruleVersion': rules['version'], 'trialReportSha256': expected_hash,
               'sampleIds': [u[0] for u in updates], 'startedAt': util.now_iso(), 'status': 'applying'}
    util.write_json(str(adoption / 'receipt.json'), receipt)
    try:
        for sample_id, record, data in updates:
            util.write_json(str(workspace / '.work/extract' / (sample_id + '.json')), data)
            for field in ('title', 'description', 'canonical', 'words'):
                record[field] = data[field]
        state.setdefault('ruleAdoptions', []).append({'trialId': trial_id, 'ruleVersion': rules['version'],
            'sampleIds': receipt['sampleIds'], 'reportSha256': expected_hash,
            'appliedSha256': {sample_id: hashlib.sha256((adoption / (sample_id + '.applied.json')).read_bytes()).hexdigest()
                              for sample_id, _record, _data in updates}})
        for sample_id, _record, _data in updates:
            state.setdefault('activeExtractionAdoptions', {})[sample_id] = {'kind': 'rules', 'trialId': trial_id}
        cli.save_state(state, str(workspace))
        naming.assign_page_files(state)
        dataset.run(state, str(workspace))
        render.run(state, str(workspace))
        blockers, _ = verify.run(state, str(workspace))
        cli.save_state(state, str(workspace))
        receipt.update(status='applied', finishedAt=util.now_iso(), blockers=len(blockers), handoffReady=False)
    except BaseException:
        receipt.update(status='interrupted', finishedAt=util.now_iso())
        util.write_json(str(adoption / 'receipt.json'), receipt)
        raise
    util.write_json(str(adoption / 'receipt.json'), receipt)
    return {'adoption': receipt, 'receipt': (adoption / 'receipt.json').relative_to(workspace).as_posix(),
            'receiptSha256': hashlib.sha256((adoption / 'receipt.json').read_bytes()).hexdigest()}


def restore_adopted(state, workspace, check_only=False):
    """A normal extract retry must not silently discard adopted task rules."""
    by_id = {r['id']: r for r in state.get('urls', {}).values()}
    latest = {}
    for adoption in state.get('ruleAdoptions', []):
        if adoption.get('state') == 'withdrawn':
            continue
        for sample_id in adoption['sampleIds']:
            latest[sample_id] = adoption
    for sample_id, adoption in latest.items():
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', sample_id) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', adoption.get('trialId', '')):
            raise ValueError('invalid rule adoption identity')
        active = state.get('activeExtractionAdoptions', {}).get(sample_id)
        if active and active != {'kind': 'rules', 'trialId': adoption['trialId']}:
            continue
        target = workspace / '.work/rule-trials' / adoption['trialId']
        report = json.loads((target / 'report.json').read_text())
        if hashlib.sha256((target / 'report.json').read_bytes()).hexdigest() != adoption['reportSha256']:
            raise ValueError('adopted report changed; new trial required')
        source = next(s['source'] for s in report['samples'] if s['sampleId'] == sample_id)
        record = by_id[sample_id]
        if hashlib.sha256((workspace / record['rawFile']).read_bytes()).hexdigest() != source['sha256']:
            raise ValueError('adopted original changed; new rule trial required: ' + sample_id)
        applied_bytes = (target / 'adoption' / (sample_id + '.applied.json')).read_bytes()
        if hashlib.sha256(applied_bytes).hexdigest() != adoption['appliedSha256'][sample_id]:
            raise ValueError('adopted extraction changed; new trial required')
        if not check_only:
            applied = json.loads(applied_bytes)
            util.write_json(str(workspace / '.work/extract' / (sample_id + '.json')), applied)
            for field in ('title', 'description', 'canonical', 'words'):
                record[field] = applied[field]


def restore_derived(state, workspace, check_only=False):
    """Validate all adopted outputs before writing; protect rule and isolated repair results."""
    workspace = Path(workspace).resolve()
    by_id = {r['id']: r for r in state.get('urls', {}).values()}
    selected = {}
    for kind, name in [('rules', 'ruleAdoptions'), ('repair', 'repairAdoptions')]:
        for adoption in state.get(name, []):
            if adoption.get('state') == 'withdrawn':
                continue
            for sample_id in adoption['sampleIds']:
                selected[sample_id] = (kind, adoption)
    for sample_id, active in state.get('activeExtractionAdoptions', {}).items():
        if active.get('kind') == 'baseline':
            selected.pop(sample_id, None)
            continue
        if active.get('kind') not in ('rules', 'repair'):
            raise ValueError('unknown active extraction adoption kind')
        name = 'ruleAdoptions' if active.get('kind') == 'rules' else 'repairAdoptions'
        matching = [a for a in state.get(name, []) if a.get('state') != 'withdrawn' and a.get('trialId') == active.get('trialId') and sample_id in a.get('sampleIds', [])]
        if len(matching) != 1:
            raise ValueError('active extraction adoption is missing or ambiguous')
        selected[sample_id] = (active['kind'], matching[0])
    restore_adopted(state, workspace, check_only=True)
    repairs = []
    for sample_id, (kind, adoption) in selected.items():
        if kind != 'repair':
            continue
        trial_id = adoption.get('trialId', '')
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', trial_id) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', sample_id):
            raise ValueError('invalid isolated repair adoption identity')
        target = workspace / '.work/code-repairs' / trial_id
        expected_receipt = (target / 'receipt.json').relative_to(workspace).as_posix()
        if adoption.get('receipt') != expected_receipt:
            raise ValueError('isolated repair receipt path mismatch')
        receipt = json.loads((target / 'receipt.json').read_text())
        if receipt.get('status') != 'applied' or any(receipt.get(k) != adoption.get(k) for k in
                ('trialId', 'taskId', 'version', 'candidateSha256', 'inputSha256', 'sourceSha256', 'appliedSha256')):
            raise ValueError('isolated repair receipt changed or not applied')
        record = by_id[sample_id]
        raw_path = workspace / record['rawFile']
        if not raw_path.resolve().is_relative_to(workspace) or hashlib.sha256(raw_path.read_bytes()).hexdigest() != adoption['sourceSha256'][sample_id]:
            raise ValueError('isolated repair original changed; rerun isolated validation: ' + sample_id)
        applied_bytes = (target / (sample_id + '.applied.json')).read_bytes()
        if hashlib.sha256(applied_bytes).hexdigest() != adoption['appliedSha256'][sample_id]:
            raise ValueError('isolated repair output changed; rerun isolated validation')
        repairs.append((sample_id, record, json.loads(applied_bytes)))
    if not check_only:
        restore_adopted(state, workspace)
        for sample_id, record, data in repairs:
            util.write_json(str(workspace / '.work/extract' / (sample_id + '.json')), data)
            for field in ('title', 'description', 'canonical', 'words'):
                if field in data:
                    record[field] = data[field]
    return set(selected)


def withdraw(request, state, workspace):
    """Restore exact previous derived files, without replacing unrelated current state."""
    from . import cli, dataset, extract, naming, render, verify
    trial_id = request.get('trialId', '')
    expected_hash = request.get('expectedReceiptHash', '')
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', trial_id) or not re.fullmatch(r'[a-f0-9]{64}', expected_hash):
        raise ValueError('withdraw requires trialId and expectedReceiptHash')
    folder = workspace / '.work/rule-trials' / trial_id
    adoption_dir = folder / 'adoption'
    receipt_path = adoption_dir / 'receipt.json'
    receipt_bytes = receipt_path.read_bytes()
    if hashlib.sha256(receipt_bytes).hexdigest() != expected_hash:
        raise ValueError('adoption receipt hash mismatch')
    receipt = json.loads(receipt_bytes)
    if receipt.get('status') not in ('applied', 'applying', 'interrupted'):
        raise ValueError('adoption receipt cannot be withdrawn from its current state')
    report = json.loads((folder / 'report.json').read_text())
    if hashlib.sha256((folder / 'report.json').read_bytes()).hexdigest() != receipt['trialReportSha256']:
        raise ValueError('trial report changed after adoption')
    previous_state = json.loads((adoption_dir / 'previous-state.json').read_text())
    previous_records = {r['id']: r for r in previous_state.get('urls', {}).values()}
    by_id = {r['id']: r for r in state.get('urls', {}).values()}
    entries = [a for a in state.get('ruleAdoptions', []) if a.get('trialId') == trial_id and a.get('state') != 'withdrawn']
    if len(entries) > 1:
        raise ValueError('ambiguous rule adoption')
    adoption_entry = entries[0] if entries else None
    pending = []
    for sample_id in receipt['sampleIds']:
        current = by_id.get(sample_id)
        if not current or sample_id not in previous_records:
            raise ValueError('adopted object identity changed')
        active = state.get('activeExtractionAdoptions', {}).get(sample_id)
        previous_active = previous_state.get('activeExtractionAdoptions', {}).get(sample_id)
        # Interrupted adoption may stop before publishing its state pointer.
        if active not in ({'kind': 'rules', 'trialId': trial_id}, previous_active):
            raise ValueError('adoption was superseded; cannot withdraw a newer version')
        if receipt['status'] == 'applied' and active != {'kind': 'rules', 'trialId': trial_id}:
            raise ValueError('adoption is no longer active')
        sample = next(s for s in report['samples'] if s['sampleId'] == sample_id)
        if hashlib.sha256((workspace / current['rawFile']).read_bytes()).hexdigest() != sample['source']['sha256']:
            raise ValueError('original changed; cannot withdraw against another source version')
        current_path = workspace / '.work/extract' / (sample_id + '.json')
        applied_path = adoption_dir / (sample_id + '.applied.json')
        previous_path = adoption_dir / (sample_id + '.previous.json')
        current_bytes = current_path.read_bytes() if current_path.exists() else None
        previous_bytes = previous_path.read_bytes() if previous_path.exists() else None
        applied_bytes = applied_path.read_bytes() if applied_path.exists() else None
        if adoption_entry and applied_bytes is not None and hashlib.sha256(applied_bytes).hexdigest() != adoption_entry['appliedSha256'][sample_id]:
            raise ValueError('adopted output changed')
        if current_bytes not in (previous_bytes, applied_bytes):
            raise ValueError('current extraction changed after adoption; cannot overwrite')
        pending.append((sample_id, current, current_path, previous_bytes))
    rollback_path = adoption_dir / 'withdrawal.json'
    if rollback_path.exists():
        raise ValueError('withdrawal already started; inspect its receipt before replay')
    withdrawal = {'trialId': trial_id, 'adoptionReceiptSha256': expected_hash, 'status': 'withdrawing',
                  'sampleIds': receipt['sampleIds'], 'startedAt': util.now_iso()}
    util.write_json(str(rollback_path), withdrawal)
    try:
        for sample_id, current, current_path, previous_bytes in pending:
            if previous_bytes is None:
                current_path.unlink(missing_ok=True)
            else:
                temporary = current_path.with_suffix('.withdraw.tmp')
                temporary.write_bytes(previous_bytes)
                temporary.replace(current_path)
            old = previous_records[sample_id]
            for field in ('title', 'description', 'canonical', 'robots', 'lang', 'pageType', 'words', 'images', 'links'):
                if field in old:
                    current[field] = old[field]
                else:
                    current.pop(field, None)
            state.setdefault('activeExtractionAdoptions', {})[sample_id] = previous_state.get('activeExtractionAdoptions', {}).get(sample_id, {'kind': 'baseline'})
        if adoption_entry:
            adoption_entry.update(state='withdrawn', withdrawnAt=util.now_iso())
        cli.save_state(state, str(workspace))
        naming.assign_page_files(state)
        dataset.run(state, str(workspace))
        render.run(state, str(workspace))
        blockers, _ = verify.run(state, str(workspace))
        cli.save_state(state, str(workspace))
        withdrawal.update(status='withdrawn', finishedAt=util.now_iso(), blockers=len(blockers), handoffReady=False)
        receipt.update(status='withdrawn', withdrawnAt=util.now_iso())
        util.write_json(str(receipt_path), receipt)
    except BaseException:
        withdrawal.update(status='interrupted', finishedAt=util.now_iso())
        util.write_json(str(rollback_path), withdrawal)
        raise
    util.write_json(str(rollback_path), withdrawal)
    return {'withdrawal': withdrawal, 'receipt': rollback_path.relative_to(workspace).as_posix(),
            'nextStages': ['extract', 'data', 'render', 'verify'],
            'receiptSha256': hashlib.sha256(rollback_path.read_bytes()).hexdigest()}
