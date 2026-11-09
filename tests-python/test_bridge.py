import contextlib
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
ENGINE = ROOT / 'engines/site-harvest'
sys.path.insert(0, str(ENGINE))
import bridge
from siteharvest import cli, discover, extract, fetch, net, rules, util
from test_harvest import state_for, html


class BridgeTests(unittest.TestCase):
    def request(self, workspace, operation, **values):
        return dict(protocolVersion=1, operation=operation, workspace=str(workspace), **values)

    def fixture(self, workspace):
        state = state_for('https://example.test/products/42.aspx')
        record = discover.add_url(state, state['source'], 'home', 0, False)
        raw = '<html lang="en"><head><title>Sample</title></head><body><article><h1>Saved product</h1><p>Specifications and full source content.</p><table><tr><td>Width</td><td>42</td></tr></table></article><a rel="next" href="?page=2">Next</a></body></html>'
        record.update(status=200, rawFile='.work/raw/' + record['id'] + '.html')
        util.write_text(str(workspace / record['rawFile']), raw)
        cli.save_state(state, str(workspace))
        return record, state

    def candidate(self):
        return {'schemaVersion': 1, 'version': 'candidate-1', 'baseVersion': 'default-1',
                'appliesTo': {'hosts': ['example.test'], 'languages': ['en'], 'pathPrefixes': ['/products/']},
                'container': '//article', 'fields': {'title': {'selector': './/h1', 'required': True}},
                'pagination': {'selector': '//a[@rel="next"]'}}

    def test_process_outside_cwd_emits_single_json(self):
        with tempfile.TemporaryDirectory(prefix='collection 中文 space ') as directory:
            result = subprocess.run([sys.executable, '-B', str(ENGINE / 'bridge.py')], cwd=directory,
                                    input=json.dumps({'protocolVersion': 1, 'operation': 'selfcheck'}),
                                    capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(json.loads(result.stdout)['result']['runtime']['compatible'])
        self.assertEqual(len(result.stdout.splitlines()), 1)

    def test_network_and_unknown_options_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(bridge.RequestError, 'authorization'):
                bridge.handle(self.request(directory, 'plan', sourceUrl='https://example.test/'))
            self.fixture(Path(directory))
            with self.assertRaisesRegex(bridge.RequestError, 'options'):
                bridge.handle(self.request(directory, 'extract', options={'browser': True}))
            with self.assertRaisesRegex(bridge.RequestError, 'integer'):
                bridge.handle(self.request(directory, 'extract', options={'maxPages': 0}))

    def test_offline_bounded_batch_preserves_unknown_coverage_and_layers(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            record, _ = self.fixture(workspace)
            original = (workspace / record['rawFile']).read_bytes()
            with patch.object(net.Fetcher, 'fetch', side_effect=AssertionError('unexpected network')):
                with contextlib.redirect_stdout(io.StringIO()):
                    result = bridge.handle(self.request(workspace, 'batch', stages=['extract', 'data', 'render', 'verify']))
            self.assertFalse(result['summary']['handoffReady'])
            self.assertIsNone(result['summary']['sourceCoverage']['total'])
            self.assertFalse(result['summary']['scopeCoverage']['complete'])
            self.assertEqual(original, (workspace / record['rawFile']).read_bytes())
            checklist = json.loads((workspace / result['checklist']).read_text())
            self.assertEqual([c['id'] for c in checklist['checks']], ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7'])
            layers = json.loads((workspace / 'site/evidence-layers.json').read_text())
            self.assertFalse(layers['candidateData']['lossless'])
            self.assertEqual(layers['candidateData']['limits']['linksPerRecord'], 20)
            index = bridge.handle(self.request(workspace, 'artifacts', limit=1))['artifacts']
            self.assertEqual(len(index['items']), 1)
            self.assertEqual(index['nextCursor'], 1)

    def test_initial_plan_does_not_conflict_with_checkpoint(self):
        class F:
            def fetch(self, url):
                response = net.Response(url)
                response.status, response.text, response.content_type = 200, html('First'), 'text/html'
                return response
        with tempfile.TemporaryDirectory() as directory, patch.object(cli, 'make_fetcher', return_value=F()):
            workspace = Path(directory) / 'new-package'
            with contextlib.redirect_stdout(io.StringIO()):
                result = bridge.handle(self.request(workspace, 'plan', sourceUrl='https://example.test/', authorization={'network': True}))
            self.assertTrue((workspace / result['checkpoint']).is_file())
            self.assertEqual(cli.load_state(str(workspace))['source'], 'https://example.test/')

    def test_entire_bounded_pipeline_uses_stubbed_network(self):
        class F:
            def __init__(self, **kwargs):
                pass
            def fetch(self, url, **kwargs):
                response = net.Response(url)
                response.status = 200
                response.content_type = 'text/html'
                if 'robots.txt' in url or 'sitemap' in url:
                    response.status = 404
                    response.text = ''
                else:
                    response.text = html('Offline pipeline', '<a href="/products/42.aspx">Detail</a>')
                    response.body = response.text.encode()
                return response
        with tempfile.TemporaryDirectory() as directory, patch.object(cli, 'Fetcher', F):
            workspace = Path(directory) / 'batch'
            with contextlib.redirect_stdout(io.StringIO()):
                result = bridge.handle(self.request(workspace, 'batch', sourceUrl='https://example.test/',
                    authorization={'network': True}, options={'maxPages': 1, 'maxDepth': 1, 'maxAssets': 2, 'maxTotalBytes': 1024}))
            self.assertEqual([r['stage'] for r in result['receipts']], list(bridge.STAGES))
            state = cli.load_state(str(workspace))
            self.assertEqual(state['limits']['maxAssets'], 2)
            self.assertEqual(state['limits']['maxTotalBytes'], 1024)
            self.assertGreater(result['summary']['knownGaps'], 0)
            self.assertFalse(result['summary']['sourceCoverage']['complete'])

    def test_saved_state_path_escape_and_symlink_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            record, state = self.fixture(workspace)
            record['rawFile'] = '../outside.html'
            cli.save_state(state, str(workspace))
            with self.assertRaisesRegex(bridge.RequestError, 'escapes'):
                bridge.handle(self.request(workspace, 'status'))
            (workspace / 'escape').symlink_to('/tmp')
            with self.assertRaisesRegex(bridge.RequestError, 'symlinks'):
                bridge.handle(self.request(workspace, 'status'))

    def test_rule_trial_preserves_original_and_state(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            record, _ = self.fixture(workspace)
            state_before = (workspace / '.work/state.json').read_bytes()
            raw_before = (workspace / record['rawFile']).read_bytes()
            result = bridge.handle(self.request(workspace, 'rules_trial', trialId='trial-1', rules=self.candidate(),
                sampleIds=[record['id']], expectations={record['id']: {'recordCount': 1, 'containsText': ['Width', '42'],
                    'fieldValues': {'title': ['Saved product']}, 'paginationUrls': ['https://example.test/products/42.aspx?page=2']}}))
            self.assertEqual(result['trial']['status'], 'passed')
            self.assertFalse(result['trial']['adopted'])
            self.assertEqual(state_before, (workspace / '.work/state.json').read_bytes())
            self.assertEqual(raw_before, (workspace / record['rawFile']).read_bytes())
            with self.assertRaisesRegex(ValueError, 'exists'):
                bridge.handle(self.request(workspace, 'rules_trial', trialId='trial-1', rules=self.candidate(), sampleIds=[record['id']]))

    def test_rule_trial_reports_failed_fixed_expectation_and_no_expectations(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            record, _ = self.fixture(workspace)
            result = bridge.handle(self.request(workspace, 'rules_trial', trialId='failure', rules=self.candidate(),
                sampleIds=[record['id']], expectations={record['id']: {'recordCount': 120}}))
            self.assertEqual(result['trial']['status'], 'failed')
            self.assertIn('recordCount expected 120 actual 1', result['trial']['samples'][0]['differences'])
            result = bridge.handle(self.request(workspace, 'rules_trial', trialId='unverified', rules=self.candidate(), sampleIds=[record['id']]))
            self.assertEqual(result['trial']['status'], 'unverified')

    def test_rules_reject_executable_xpath_and_conflicts(self):
        for expression in ['document("file:///secret")', '//article | //script', '//article[contains(@id,"x")]', '//article/../../secret']:
            candidate = self.candidate()
            candidate['container'] = expression
            with self.assertRaises(ValueError):
                rules.validate(candidate)
        candidate = self.candidate()
        output = rules.apply('<article><h1>One</h1><h1>Two</h1></article>', 'https://example.test/products/a', candidate)
        self.assertFalse(output['applicable'])  # language applicability does not silently fall back
        candidate.pop('appliesTo')
        output = rules.apply('<article><h1>One</h1><h1>Two</h1></article>', 'https://example.test/products/a', candidate)
        self.assertIn('ambiguous', output['issues'][0])

    def test_rule_apply_binds_trial_and_preserves_previous_extraction(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            record, _ = self.fixture(workspace)
            with contextlib.redirect_stdout(io.StringIO()):
                bridge.handle(self.request(workspace, 'extract'))
            original = (workspace / record['rawFile']).read_bytes()
            extract_path = workspace / '.work/extract' / (record['id'] + '.json')
            previous = extract_path.read_bytes()
            result = bridge.handle(self.request(workspace, 'rules_trial', trialId='apply-test', rules=self.candidate(),
                sampleIds=[record['id']], expectations={record['id']: {'recordCount': 1, 'containsText': ['Specifications', '42']}}))
            with self.assertRaisesRegex(ValueError, 'hash mismatch'):
                bridge.handle(self.request(workspace, 'rules_apply', trialId='apply-test', expectedTrialHash='0' * 64))
            with contextlib.redirect_stdout(io.StringIO()):
                applied = bridge.handle(self.request(workspace, 'rules_apply', trialId='apply-test', expectedTrialHash=result['reportSha256']))
            self.assertEqual(applied['adoption']['status'], 'applied')
            self.assertEqual(original, (workspace / record['rawFile']).read_bytes())
            self.assertEqual(previous, (workspace / '.work/rule-trials/apply-test/adoption' / (record['id'] + '.previous.json')).read_bytes())
            data = json.loads(extract_path.read_text())
            self.assertEqual(data['ruleExtraction']['trialId'], 'apply-test')
            self.assertTrue(data['tables'])
            self.assertFalse(applied['summary']['handoffReady'])
            with contextlib.redirect_stdout(io.StringIO()):
                bridge.handle(self.request(workspace, 'extract'))
            self.assertEqual(json.loads(extract_path.read_text())['ruleExtraction']['trialId'], 'apply-test')
            with self.assertRaisesRegex(ValueError, 'already applied'):
                bridge.handle(self.request(workspace, 'rules_apply', trialId='apply-test', expectedTrialHash=result['reportSha256']))

    def test_rule_apply_rejects_changed_original_and_unverified_trial(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            record, _ = self.fixture(workspace)
            unverified = bridge.handle(self.request(workspace, 'rules_trial', trialId='no-expectation', rules=self.candidate(),
                sampleIds=[record['id']], expectations={record['id']: {'containsText': []}}))
            self.assertEqual(unverified['trial']['status'], 'unverified')
            with self.assertRaisesRegex(ValueError, 'passing'):
                bridge.handle(self.request(workspace, 'rules_apply', trialId='no-expectation', expectedTrialHash=unverified['reportSha256']))
            result = bridge.handle(self.request(workspace, 'rules_trial', trialId='changed', rules=self.candidate(),
                sampleIds=[record['id']], expectations={record['id']: {'recordCount': 1}}))
            (workspace / record['rawFile']).write_text('changed source')
            with self.assertRaisesRegex(ValueError, 'original changed'):
                bridge.handle(self.request(workspace, 'rules_apply', trialId='changed', expectedTrialHash=result['reportSha256']))

    def test_saved_http_body_retains_encoding_bytes_without_secrets(self):
        class F:
            def fetch(self, url, **kwargs):
                response = net.Response(url)
                response.status, response.content_type, response.charset = 200, 'text/html', 'gb18030'
                response.text = '<html><body>中文原件</body></html>'
                response.body = response.text.encode('gb18030')
                response.headers = {'Content-Type': 'text/html', 'Set-Cookie': 'secret'}
                return response
        with tempfile.TemporaryDirectory() as directory:
            state = state_for()
            record = discover.add_url(state, state['source'], 'home', 0, False)
            response = fetch._fetch_one(record, F(), directory, state['siteHosts'])
            saved = response.harvest_record
            self.assertEqual((Path(directory) / saved['responseBodyFile']).read_bytes(), response.body)
            metadata = json.loads((Path(directory) / saved['responseMetadataFile']).read_text())
            self.assertEqual(metadata['sha256'], hashlib.sha256(response.body).hexdigest())
            self.assertNotIn('Set-Cookie', metadata['headers'])

    def test_extract_preserves_isolated_repair_and_rejects_changed_source(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            record, state = self.fixture(workspace)
            trial_id = 'repair-trial'
            folder = workspace / '.work/code-repairs' / trial_id
            folder.mkdir(parents=True)
            data = extract.extract_page((workspace / record['rawFile']).read_text(), record['url'])
            data['fullText'] += '\nValidated isolated repair content'
            data['blocks'] = [{'kind': 'p', 'text': 'Validated isolated repair content', 'hidden': False}]
            util.write_json(str(folder / (record['id'] + '.applied.json')), data)
            applied_hash = hashlib.sha256((folder / (record['id'] + '.applied.json')).read_bytes()).hexdigest()
            source_hash = hashlib.sha256((workspace / record['rawFile']).read_bytes()).hexdigest()
            adoption = {'trialId': trial_id, 'taskId': 'task-1', 'version': 'task-repair:v1',
                'candidateSha256': 'a' * 64, 'inputSha256': 'b' * 64, 'sampleIds': [record['id']],
                'sourceSha256': {record['id']: source_hash}, 'appliedSha256': {record['id']: applied_hash},
                'receipt': '.work/code-repairs/' + trial_id + '/receipt.json'}
            util.write_json(str(folder / 'receipt.json'), dict(adoption, schemaVersion=1, status='applied'))
            state['repairAdoptions'] = [adoption]
            state['activeExtractionAdoptions'] = {record['id']: {'kind': 'repair', 'trialId': trial_id}}
            cli.save_state(state, str(workspace))
            with patch.object(extract, 'extract_page', side_effect=AssertionError('adopted page must be skipped')):
                extract.run(state, str(workspace), log=lambda _message: None)
            output = workspace / '.work/extract' / (record['id'] + '.json')
            self.assertIn('Validated isolated repair', json.loads(output.read_text())['fullText'])
            before = output.read_bytes()
            (workspace / record['rawFile']).write_text('Changed source, needs new isolated trial')
            with self.assertRaisesRegex(ValueError, 'rerun isolated validation'):
                extract.run(state, str(workspace), log=lambda _message: None)
            self.assertEqual(before, output.read_bytes())

    def test_extract_rejects_unsettled_repair_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            record, state = self.fixture(workspace)
            folder = workspace / '.work/code-repairs/interrupted'
            folder.mkdir(parents=True)
            adoption = {'trialId': 'interrupted', 'taskId': 'task-1', 'version': 'v1',
                'candidateSha256': 'a' * 64, 'inputSha256': 'b' * 64, 'sampleIds': [record['id']],
                'sourceSha256': {record['id']: 'c' * 64}, 'appliedSha256': {record['id']: 'd' * 64},
                'receipt': '.work/code-repairs/interrupted/receipt.json'}
            util.write_json(str(folder / 'receipt.json'), dict(adoption, status='applying'))
            state['repairAdoptions'] = [adoption]
            with self.assertRaisesRegex(ValueError, 'not applied'):
                extract.run(state, str(workspace), log=lambda _message: None)

    def test_discover_recovers_saved_state_without_rebuilding_ids(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            record, state = self.fixture(workspace)
            before = {key: row['id'] for key, row in state['urls'].items()}
            def resume(args):
                current = cli.load_state(args.out)
                discover.add_url(current, 'https://example.test/products/43.aspx', 'link', 1, False)
                cli.save_state(current, args.out)
            with patch.object(cli, 'cmd_discover', side_effect=AssertionError('must not rebuild discovery')), \
                 patch.object(cli, 'cmd_fetch', side_effect=resume):
                result = bridge.handle(self.request(workspace, 'discover', authorization={'network': True}))
            after = cli.load_state(str(workspace))
            self.assertTrue(all(after['urls'][key]['id'] == value for key, value in before.items()))
            self.assertEqual(result['receipts'][0]['status'], 'recovered')
            self.assertEqual(len(after['urls']), len(before) + 1)

    def test_rule_withdraw_restores_exact_previous_and_allows_baseline_extract(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            record, _ = self.fixture(workspace)
            with contextlib.redirect_stdout(io.StringIO()):
                bridge.handle(self.request(workspace, 'extract'))
            path = workspace / '.work/extract' / (record['id'] + '.json')
            previous = path.read_bytes()
            raw = (workspace / record['rawFile']).read_bytes()
            trial = bridge.handle(self.request(workspace, 'rules_trial', trialId='withdraw-rule', rules=self.candidate(),
                sampleIds=[record['id']], expectations={record['id']: {'recordCount': 1}}))
            with contextlib.redirect_stdout(io.StringIO()):
                applied = bridge.handle(self.request(workspace, 'rules_apply', trialId='withdraw-rule', expectedTrialHash=trial['reportSha256']))
                withdrawn = bridge.handle(self.request(workspace, 'rules_withdraw', trialId='withdraw-rule', expectedReceiptHash=applied['receiptSha256']))
            self.assertEqual(withdrawn['withdrawal']['status'], 'withdrawn')
            self.assertEqual(previous, path.read_bytes())
            self.assertEqual(raw, (workspace / record['rawFile']).read_bytes())
            state = cli.load_state(str(workspace))
            self.assertEqual(state['activeExtractionAdoptions'][record['id']], {'kind': 'baseline'})
            self.assertEqual(state['ruleAdoptions'][0]['state'], 'withdrawn')
            with contextlib.redirect_stdout(io.StringIO()):
                bridge.handle(self.request(workspace, 'extract'))
            self.assertNotIn('ruleExtraction', json.loads(path.read_text()))

    def test_rule_withdraw_rejects_superseded_output_and_receipt_tampering(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            record, _ = self.fixture(workspace)
            trial = bridge.handle(self.request(workspace, 'rules_trial', trialId='superseded-rule', rules=self.candidate(),
                sampleIds=[record['id']], expectations={record['id']: {'recordCount': 1}}))
            with contextlib.redirect_stdout(io.StringIO()):
                applied = bridge.handle(self.request(workspace, 'rules_apply', trialId='superseded-rule', expectedTrialHash=trial['reportSha256']))
            with self.assertRaisesRegex(ValueError, 'hash mismatch'):
                bridge.handle(self.request(workspace, 'rules_withdraw', trialId='superseded-rule', expectedReceiptHash='0' * 64))
            state = cli.load_state(str(workspace))
            state['activeExtractionAdoptions'][record['id']] = {'kind': 'repair', 'trialId': 'newer'}
            cli.save_state(state, str(workspace))
            with self.assertRaisesRegex(ValueError, 'superseded'):
                bridge.handle(self.request(workspace, 'rules_withdraw', trialId='superseded-rule', expectedReceiptHash=applied['receiptSha256']))

    def test_rule_withdraw_recovers_apply_failure_before_state_publication(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            record, _ = self.fixture(workspace)
            with contextlib.redirect_stdout(io.StringIO()):
                bridge.handle(self.request(workspace, 'extract'))
            path = workspace / '.work/extract' / (record['id'] + '.json')
            previous = path.read_bytes()
            trial = bridge.handle(self.request(workspace, 'rules_trial', trialId='failed-apply', rules=self.candidate(),
                sampleIds=[record['id']], expectations={record['id']: {'recordCount': 1}}))
            with patch.object(cli, 'save_state', side_effect=RuntimeError('simulated state publication failure')):
                with self.assertRaisesRegex(RuntimeError, 'publication failure'):
                    bridge.handle(self.request(workspace, 'rules_apply', trialId='failed-apply', expectedTrialHash=trial['reportSha256']))
            receipt = workspace / '.work/rule-trials/failed-apply/adoption/receipt.json'
            receipt_hash = hashlib.sha256(receipt.read_bytes()).hexdigest()
            with contextlib.redirect_stdout(io.StringIO()):
                withdrawn = bridge.handle(self.request(workspace, 'rules_withdraw', trialId='failed-apply', expectedReceiptHash=receipt_hash))
            self.assertEqual(withdrawn['withdrawal']['status'], 'withdrawn')
            self.assertEqual(previous, path.read_bytes())

    def test_withdrawn_repair_baseline_marker_does_not_replay_old_output(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            record, state = self.fixture(workspace)
            state['repairAdoptions'] = [{'trialId': 'withdrawn-repair', 'sampleIds': [record['id']], 'state': 'withdrawn'}]
            state['activeExtractionAdoptions'] = {record['id']: {'kind': 'baseline'}}
            # No old repair files exist: withdrawn adoption must never be read or restored.
            extract.run(state, str(workspace), log=lambda _message: None)
            data = json.loads((workspace / '.work/extract' / (record['id'] + '.json')).read_text())
            self.assertIn('Specifications', data['fullText'])
            self.assertNotIn('codeRepair', data)


if __name__ == '__main__':
    unittest.main()
