#!/usr/bin/env python3
"""One JSON request on stdin, one JSON result on stdout; diagnostic logs on stderr."""
import contextlib
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import sys
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
VERSION = json.loads((ROOT / 'engine-version.json').read_text())
STAGES = ('plan', 'discover', 'fetch', 'extract', 'assets', 'data', 'render', 'verify')
NETWORK = {'plan', 'discover', 'fetch', 'assets'}


class RequestError(ValueError):
    pass


def integer(value, name, low, high):
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise RequestError('%s must be an integer in [%d,%d]' % (name, low, high))
    return value


def safe_path(workspace, relative):
    if not isinstance(relative, str) or Path(relative).is_absolute():
        raise RequestError('artifact paths must be relative')
    candidate = workspace / relative
    if candidate.is_symlink() or not candidate.resolve().is_relative_to(workspace):
        raise RequestError('artifact escapes workspace')
    return candidate


def runtime_info():
    import lxml
    compatible = sys.version_info[:2] == (3, 12) and lxml.__version__ == VERSION['dependencies']['lxml']
    digest = hashlib.sha256()
    for path in sorted(ROOT.rglob('*.py')):
        digest.update(path.relative_to(ROOT).as_posix().encode())
        digest.update(b'\0')
        digest.update(path.read_bytes())
    return dict(VERSION, engineSourceSha256=digest.hexdigest(), pythonActual=platform.python_version(), dependenciesActual={'lxml': lxml.__version__},
                compatible=compatible, enginePath=str(ROOT), executable=sys.executable)


def workspace_for(value):
    if not isinstance(value, str) or not Path(value).is_absolute():
        raise RequestError('workspace must be an absolute task-owned directory')
    path = Path(value)
    # A workspace is supplied only by Node, never chosen by model tool arguments.
    # Canonicalize OS aliases such as macOS /var -> /private/var.
    if path.is_symlink():
        raise RequestError('workspace must not use symlinks')
    workspace = path.resolve()
    if workspace == ROOT or ROOT.is_relative_to(workspace) or workspace.is_relative_to(ROOT):
        raise RequestError('workspace must be separate from engine sources')
    if workspace.exists() and any(p.is_symlink() for p in workspace.rglob('*')):
        raise RequestError('workspace contains symlinks')
    return workspace


def validate_state(state, workspace):
    if not state:
        return
    for record in state.get('urls', {}).values():
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', record.get('id', '')):
            raise RequestError('invalid saved object ID')
        for name in ('rawFile', 'pageFile', 'responseBodyFile', 'responseMetadataFile'):
            if record.get(name):
                safe_path(workspace, record[name])
    for asset in state.get('assets', []) + state.get('files', []):
        if asset.get('localPath'):
            safe_path(workspace, asset['localPath'])


def options_for(request):
    options = request.get('options', {})
    allowed = {'maxPages', 'maxDepth', 'maxAssets', 'maxTotalBytes', 'delay', 'retryFailed',
               'seedUrls', 'language', 'excludePrefixes', 'mode', 'minRecords'}
    if not isinstance(options, dict) or set(options) - allowed:
        raise RequestError('unknown or invalid options')
    for name, low, high in [('maxPages', 1, 10000), ('maxDepth', 0, 30), ('maxAssets', 1, 50000),
                            ('maxTotalBytes', 1, 20 * 1024**3), ('minRecords', 1, 10000)]:
        if name in options:
            integer(options[name], name, low, high)
    delay = options.get('delay', 0.3)
    if isinstance(delay, bool) or not isinstance(delay, (float, int)) or not 0 <= delay <= 30:
        raise RequestError('delay must be between 0 and 30 seconds')
    for name in ('seedUrls', 'excludePrefixes'):
        if name in options and (not isinstance(options[name], list) or len(options[name]) > 1000
                                or any(not isinstance(v, str) or len(v) > 4096 for v in options[name])):
            raise RequestError('invalid ' + name)
    if 'retryFailed' in options and not isinstance(options['retryFailed'], bool):
        raise RequestError('retryFailed must be boolean')
    if 'mode' in options and options['mode'] not in ('A', 'B'):
        raise RequestError('mode must be A or B')
    if not isinstance(options.get('language', ''), str):
        raise RequestError('language must be a string')
    return options


def artifact_index(workspace, cursor=0, limit=100):
    rows = []
    if workspace.exists():
        for path in sorted(workspace.rglob('*')):
            if path.is_file():
                rel = path.relative_to(workspace).as_posix()
                if rel == '.work/platform-checkpoint.json':
                    continue
                rows.append({'path': rel, 'bytes': path.stat().st_size,
                             'layer': 'response-body' if rel.startswith('.work/responses/') else
                             'saved-html' if rel.startswith('.work/raw/') else
                             'extracted' if rel.startswith(('.work/extract/', 'site/evidence/', 'site/pages/')) else
                             'candidate' if rel.startswith('data/') else 'report-or-asset'})
    page = rows[cursor:cursor + limit]
    return dict(items=page, total=len(rows), cursor=cursor, nextCursor=cursor + len(page) if cursor + len(page) < len(rows) else None)


def summary(state, workspace):
    from siteharvest import completeness
    report = completeness.assess(state, str(workspace)) if state else {'findings': [], 'gaps': 0, 'reviews': 0}
    return {'sourceUrl': state.get('source') if state else None, 'counts': state.get('counts', {}) if state else {},
            'assetStats': state.get('assetStats', {}) if state else {},
            'mechanicalStatus': report.get('status', 'not-started'), 'knownGaps': report['gaps'],
            'pendingReviews': report['reviews'],
            'sourceCoverage': {'status': 'unknown', 'total': None, 'complete': False},
            'scopeCoverage': {'status': 'unverified', 'complete': False},
            'handoffReady': False,
            'boundary': 'Known URL closure and file checks do not establish source completeness; independent review required.'}


def write_checklist(state, workspace):
    from siteharvest import completeness, util
    report = completeness.assess(state, str(workspace))
    records = [r for r in state.get('urls', {}).values() if r.get('action') == 'keep']
    missing_originals = [r['id'] for r in records if not r.get('rawFile') or not safe_path(workspace, r['rawFile']).is_file()]
    missing_extracts = [r['id'] for r in records if not safe_path(workspace, '.work/extract/' + r['id'] + '.json').is_file()]
    findings = report['findings']
    def check(identifier, gaps, refs, reason):
        return {'id': identifier, 'status': 'failed' if gaps else 'unverified', 'gaps': gaps,
                'evidence': refs, 'reason': reason}
    checks = [
        check('A1', [], ['.work/state.json'], 'Host/language settings require comparison with authorized task scope.'),
        check('A2', [f for f in findings if f['severity'] == 'gap' and f['kind'] == 'discovery'],
              ['site/discovery.json'], 'Static discovery does not prove dynamic entries were exhausted.'),
        check('A3', [], ['site/coverage.csv', 'data/page-groups.json'], 'No independent source record total/pagination expectation supplied.'),
        check('A4', missing_originals + [f for f in findings if f['severity'] == 'gap' and f['kind'] in ('page', 'redirect')],
              ['.work/raw/', '.work/state.json'], 'Saved HTML is distinct from original response bytes and from rendered DOM.'),
        check('A5', missing_extracts + [f for f in findings if f['severity'] == 'gap' and f['kind'] == 'content'],
              ['.work/extract/', 'site/evidence/', 'site/pages/'], 'fullText is extracted; candidate records may abbreviate. Semantic review remains required.'),
        check('A6', [f for f in findings if f['severity'] == 'gap' and f['kind'] in ('asset', 'stylesheet')],
              ['site/assets.csv', '.work/state.json'], 'Downloaded PDF/image does not establish extracted PDF text/OCR.'),
        check('A7', [], ['.work/platform-checkpoint.json'], 'Platform must freeze matching material, manifest, rules and independent review versions.'),
    ]
    result = {'version': VERSION['verifierVersion'], 'checks': checks, 'findings': findings, **summary(state, workspace)}
    util.write_json(str(workspace / 'site/a-checklist.json'), result)
    util.write_json(str(workspace / 'site/evidence-layers.json'), {
        'responseBody': {'path': '.work/responses/', 'meaning': 'Decompressed HTTP body bytes before text decoding, when available; not wire capture.'},
        'savedHtml': {'path': '.work/raw/', 'meaning': 'Decoded UTF-8 saved HTML; browser DOM is separately marked in state.'},
        'extraction': {'paths': ['.work/extract/', 'site/evidence/'], 'meaning': 'Derived fullText and blocks, not original response.'},
        'candidateData': {'path': 'data/', 'lossless': False,
                          'limits': {'titleChars': 200, 'summaryChars': 500, 'sectionTitleChars': 160,
                                     'paragraphChars': 20000, 'tableCellChars': 200, 'linksPerRecord': 20,
                                     'csvTextChars': 4000},
                          'meaning': 'Heuristic groups may filter shared navigation/hidden blocks and abbreviate fields; read extraction and originals for migration.'}
    })
    return 'site/a-checklist.json'


def handle(request):
    if not isinstance(request, dict) or request.get('protocolVersion') != 1:
        raise RequestError('protocolVersion must be 1')
    allowed = {'protocolVersion', 'requestId', 'operation', 'workspace', 'sourceUrl', 'options', 'authorization',
               'stages', 'cursor', 'limit', 'rules', 'sampleIds', 'expectations', 'trialId', 'expectedTrialHash', 'expectedReceiptHash'}
    if set(request) - allowed:
        raise RequestError('unknown request fields')
    operation = request.get('operation')
    runtime = runtime_info()
    if operation == 'selfcheck':
        return {'runtime': runtime, 'operations': [*STAGES, 'status', 'batch', 'rules_trial', 'rules_apply', 'rules_withdraw', 'artifacts']}
    if not runtime['compatible']:
        raise RequestError('managed runtime mismatch: require Python 3.12 and lxml 6.1.1')
    workspace = workspace_for(request.get('workspace'))
    from siteharvest import cli, util
    state = cli.load_state(str(workspace)) or {}
    validate_state(state, workspace)
    if operation == 'artifacts':
        return {'artifacts': artifact_index(workspace, integer(request.get('cursor', 0), 'cursor', 0, 10**9),
                                           integer(request.get('limit', 100), 'limit', 1, 500))}
    if operation == 'status':
        return {'summary': summary(state, workspace), 'checkpoint': '.work/platform-checkpoint.json' if (workspace / '.work/platform-checkpoint.json').exists() else None,
                'artifacts': artifact_index(workspace)}
    if operation == 'rules_trial':
        if not state:
            raise RequestError('workspace has no saved state')
        from siteharvest.rules import trial
        return trial(request, state, workspace)
    if operation == 'rules_apply':
        if not state:
            raise RequestError('workspace has no saved state')
        from siteharvest.rules import adopt
        result = adopt(request, state, workspace)
        result.update(summary=summary(state, workspace), checklist=write_checklist(state, workspace), artifacts=artifact_index(workspace))
        return result
    if operation == 'rules_withdraw':
        if not state:
            raise RequestError('workspace has no saved state')
        from siteharvest.rules import withdraw
        result = withdraw(request, state, workspace)
        result.update(summary=summary(state, workspace), checklist=write_checklist(state, workspace), artifacts=artifact_index(workspace))
        return result
    stages = request.get('stages', list(STAGES)) if operation == 'batch' else [operation]
    if not isinstance(stages, list) or not stages or any(s not in STAGES for s in stages) or len(stages) != len(set(stages)):
        raise RequestError('invalid stages')
    if any(s in NETWORK for s in stages) and request.get('authorization', {}).get('network') is not True:
        raise RequestError('network stages require platform authorization.network=true')
    if 'plan' in stages:
        url = request.get('sourceUrl', '')
        parts = urlsplit(url) if isinstance(url, str) else None
        if not parts or parts.scheme not in ('http', 'https') or not parts.hostname or parts.username or parts.password:
            raise RequestError('sourceUrl must be an HTTP(S) URL without credentials')
        if state and state.get('source') != url:
            raise RequestError('workspace belongs to a different source')
    elif not state:
        raise RequestError('plan must establish saved state first')
    options = options_for(request)
    argv = ['all' if operation == 'batch' else operation, '--out', str(workspace)]
    if operation == 'batch' or operation == 'plan':
        argv += ['--url', request.get('sourceUrl') or state.get('source', '')]
    args = cli.build_parser().parse_args(argv)
    mapping = {'maxPages': 'max_pages', 'maxDepth': 'max_depth', 'delay': 'delay', 'retryFailed': 'retry_failed',
               'seedUrls': 'seed_url', 'language': 'language', 'excludePrefixes': 'exclude_prefix', 'mode': 'mode', 'minRecords': 'min_records'}
    for name, value in options.items():
        if name in mapping:
            setattr(args, mapping[name], value)
    request_id = request.get('requestId')
    if request_id is not None and (not isinstance(request_id, str) or len(request_id) > 200):
        raise RequestError('invalid requestId')
    receipts = []
    for stage in stages:
        if stage != 'plan':
            state = cli.load_state(str(workspace)) or {}
            for key in ('maxAssets', 'maxTotalBytes', 'maxPages', 'maxDepth'):
                if key in options:
                    state.setdefault('limits', {})[key] = options[key]
            cli.save_state(state, str(workspace))
        checkpoint = {'protocolVersion': 1, 'requestId': request_id, 'operation': operation, 'stage': stage,
                      'status': 'running', 'startedAt': util.now_iso(), 'receipts': receipts, 'versions': VERSION}
        # New plan requires an empty package directory; Node owns the durable operation start.
        if stage != 'plan' or state:
            util.write_json(str(workspace / '.work/platform-checkpoint.json'), checkpoint)
        print(json.dumps({'event': 'stage-start', 'stage': stage, 'requestId': request_id}), file=sys.stderr, flush=True)
        try:
            recovered = stage == 'discover' and bool(state.get('urls')) and state.get('version') == 2
            if recovered:
                # Saved discovery is authoritative even if its platform receipt was interrupted.
                # Fetch resumes links from saved originals without rebuilding stable URL IDs.
                cli.cmd_fetch(args)
            else:
                getattr(cli, 'cmd_' + stage)(args)
            if stage == 'plan':
                state = cli.load_state(str(workspace))
                for key in ('maxAssets', 'maxTotalBytes'):
                    if key in options:
                        state['limits'][key] = options[key]
                cli.save_state(state, str(workspace))
        except BaseException:
            checkpoint.update(status='failed', finishedAt=util.now_iso())
            util.write_json(str(workspace / '.work/platform-checkpoint.json'), checkpoint)
            raise
        receipts.append({'stage': stage, 'status': 'recovered' if recovered else 'executed', 'finishedAt': util.now_iso(),
                         **({'recovery': 'saved-discovery-resumed-with-stable-ids'} if recovered else {})})
        checkpoint.update(status='completed', finishedAt=util.now_iso(), receipts=receipts)
        util.write_json(str(workspace / '.work/platform-checkpoint.json'), checkpoint)
    state = cli.load_state(str(workspace)) or {}
    checklist = write_checklist(state, workspace)
    return {'summary': summary(state, workspace), 'receipts': receipts, 'checkpoint': '.work/platform-checkpoint.json',
            'checklist': checklist, 'artifacts': artifact_index(workspace)}


def main():
    request = None
    try:
        raw = sys.stdin.buffer.read(2 * 1024 * 1024 + 1)
        if len(raw) > 2 * 1024 * 1024:
            raise RequestError('request exceeds 2MiB')
        request = json.loads(raw)
        with contextlib.redirect_stdout(sys.stderr):
            result = handle(request)
        response = {'protocolVersion': 1, 'requestId': request.get('requestId'), 'ok': True, 'result': result}
        code = 0
    except (Exception, SystemExit) as error:
        print('site-harvest: %s' % error, file=sys.stderr)
        response = {'protocolVersion': 1, 'requestId': request.get('requestId') if isinstance(request, dict) else None,
                    'ok': False, 'error': {'code': 'invalid-request' if isinstance(error, (RequestError, json.JSONDecodeError)) else 'engine-error',
                                         'message': str(error)}}
        code = 1
    print(json.dumps(response, ensure_ascii=False), flush=True)
    return code


if __name__ == '__main__':
    raise SystemExit(main())
