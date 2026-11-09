#!/usr/bin/env python3
"""Validate and package requirement documents; never generate or run the app."""
import csv
import hashlib
import json
import re
import struct
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import unquote
from zoneinfo import ZoneInfo

BASE = Path(__file__).resolve().parent
PACKAGE = BASE / 'package'
VERSION = 'task-board-requirements-v1.0-review'
MANIFEST = PACKAGE / 'manifest.json'
DELIVERY = BASE / 'deliverables'
ARCHIVE = DELIVERY / (VERSION + '.zip')


def check(condition, message):
    if not condition:
        raise ValueError(message)


def validate():
    decisions = re.findall(r'^## D(\d{3})：', (BASE / 'decisions.md').read_text(), re.M)
    check(decisions == [f'{i:03}' for i in range(1, 131)], 'D001—D130 must be continuous')
    markdown_count = 0
    for path in sorted(BASE.parent.rglob('*.md')):
        markdown_count += 1
        content = path.read_text()
        check(all(line == line.rstrip() for line in content.splitlines()), f'trailing whitespace: {path}')
        for target in re.findall(r'!?\[[^\]]*\]\(([^)]+)\)', content):
            target = target.strip('<>').split('#', 1)[0]
            if not target or re.match(r'^[a-zA-Z][a-zA-Z0-9+.-]*:', target):
                continue
            resolved = (path.parent / unquote(target)).resolve()
            check(resolved in (MANIFEST, ARCHIVE) or resolved.exists(), f'broken reference: {path}: {target}')

    case_text = (PACKAGE / '12-acceptance.md').read_text()
    expected_rows = [[v.strip() for v in line.strip('|').split('|')]
                     for line in case_text.splitlines() if line.startswith('| A')]
    check([r[0] for r in expected_rows] == [f'A{i:03}' for i in range(1, 85)], 'A001—A084 must be continuous')
    with (PACKAGE / 'acceptance-results.csv').open(encoding='utf-8-sig', newline='') as stream:
        results = list(csv.DictReader(stream))
    check(len(results) == 84, 'CSV must have 84 cases')
    for source, result in zip(expected_rows, results):
        check(source == [result[k] for k in ['编号', '前置', '操作', '预期']], f'CSV differs: {source[0]}')
        check(result['结论'] == '未执行' and not any(result[k] for k in
              ['实际结果', '证据位置', '执行时间UTC', '执行者', '运行批次']), 'template must remain unexecuted')

    data = json.loads((PACKAGE / 'samples/scenario.json').read_text())
    check(data['artifactVersion'] == VERSION, 'scenario version differs')
    users = {u['userKey'] for u in data['users']}
    projects = {p['projectKey']: p for p in data['projects']}
    tasks = data['tasks']
    check(len(users) == 6 and len(projects) == 2 and len(tasks) == 10, 'sample counts differ')
    check(len({t['taskKey'] for t in tasks}) == 10, 'duplicate task keys')
    check([t['expectedNumberInEmptyApp'] for t in tasks] == [f'#{i:04}' for i in range(1, 11)], 'number examples differ')
    for project in projects.values():
        members = project['members']
        check(len({m['userKey'] for m in members}) == len(members), 'duplicate membership')
        check(any(m['role'] == 'administrator' for m in members), 'sample project needs administrator')
        check(all(m['userKey'] in users for m in members), 'unknown member')
        columns = project['columns']
        check(sum(c['isDefault'] for c in columns) == 1 and sum(c['isCompleted'] for c in columns) == 1,
              'one default and completed column required')
        check(not any(c['isDefault'] and c['isCompleted'] for c in columns), 'default/completed must differ')
    reference = datetime.fromisoformat(data['referenceT0Utc'].replace('Z', '+00:00'))
    for task in tasks:
        project = projects[task['projectKey']]
        members = {m['userKey'] for m in project['members']}
        check(task['creatorUserKey'] in users, 'unknown creator')
        completed = next(c['isCompleted'] for c in project['columns'] if c['columnKey'] == task['columnKey'])
        owner = task['assigneeUserKey']
        check(owner is None or owner in members or (completed and owner in project['departedUserKeys']), 'invalid sample assignee')
        check(set(task['labelKeys']) <= {l['labelKey'] for l in project['labels']}, 'label from wrong project')
        hours = task['dueOffsetHoursFromT0']
        expected_due = (reference + timedelta(hours=hours)).isoformat().replace('+00:00', 'Z') if hours is not None else None
        check(task['referenceDueAtUtc'] == expected_due, 'deadline conversion differs')
        if 'descriptionMarkdownFile' in task:
            check((PACKAGE / 'samples' / task['descriptionMarkdownFile']).exists(), 'missing description')
    by_key = {t['taskKey']: t for t in tasks}
    check(any(e['event'] == 'removeMember' and e['userKey'] == 'lee' for e in data['requiredLifecycleEvents']), 'missing departed-user lifecycle')
    for comment in data['comments']:
        task = by_key[comment['taskKey']]
        members = {m['userKey'] for m in projects[task['projectKey']]['members']}
        check(comment['authorUserKey'] in members and set(comment['mentionUserKeys']) <= members, 'invalid comment identity')
        check((PACKAGE / 'samples' / comment['markdownFile']).exists(), 'missing comment')
    for column, keys in data['boardOrderIncludingArchived'].items():
        check(set(keys) == {t['taskKey'] for t in tasks if t['columnKey'] == column}, 'board order missing tasks')
    for project_key, keys in data['initialManualListOrder'].items():
        check(set(keys) == {t['taskKey'] for t in tasks if t['projectKey'] == project_key}, 'manual order missing tasks')
    visible = [t for t in tasks if t['projectKey'] == 'A' and not t['archived']]
    keylist = lambda rows: [t['taskKey'] for t in rows]
    queries = {
        'A-visible': keylist(visible),
        'A-archived': keylist([t for t in tasks if t['projectKey'] == 'A' and t['archived']]),
        'B-visible': keylist([t for t in tasks if t['projectKey'] == 'B' and not t['archived']]),
        'A-mine-chen': keylist([t for t in visible if t['assigneeUserKey'] == 'chen']),
        'A-overdue-visible': keylist([t for t in visible if t['dueOffsetHoursFromT0'] is not None
                                     and t['dueOffsetHoursFromT0'] < 0 and t['columnKey'] != 'A-done']),
        'A-unassigned-visible': keylist([t for t in visible if t['assigneeUserKey'] is None]),
        'A-no-deadline-visible': keylist([t for t in visible if t['dueOffsetHoursFromT0'] is None]),
        'A-search-login': keylist([t for t in visible if '登录流程联调' in t['title']]),
        'A-high-ui-or-bug': keylist([t for t in visible if t['priority'] == 'high'
                                   and set(t['labelKeys']) & {'A-ui', 'A-bug'}]),
        'A-default-list': keylist(sorted(visible, key=lambda t: t['creationOrder'], reverse=True))
    }
    check(queries == data['expectedQueriesAtT0'], 'sample query expectations differ')
    check([sum(t['columnKey'] == c for t in visible) for c in ['A-todo', 'A-doing', 'A-done']] == [3, 1, 2], 'column counts differ')
    for filename, size in [('board-sketch.png', (960, 540)), ('review-note.png', (640, 360))]:
        raw = (PACKAGE / 'samples/assets' / filename).read_bytes()
        check(raw[:8] == b'\x89PNG\r\n\x1a\n' and struct.unpack('!II', raw[16:24]) == size, 'PNG differs')
    ny = ZoneInfo('America/New_York')
    for day, hours in [(datetime(2027, 3, 14, tzinfo=ny), 23), (datetime(2027, 11, 7, tzinfo=ny), 25)]:
        duration = (day + timedelta(days=1)).astimezone(timezone.utc) - day.astimezone(timezone.utc)
        check(duration.total_seconds() == hours * 3600, 'DST sample differs from local timezone database')
    return markdown_count


def build():
    markdown_count = validate()
    files = sorted(p for p in PACKAGE.rglob('*') if p.is_file() and p != MANIFEST)
    manifest = {
        'artifactVersion': VERSION, 'preparedOn': '2026-11-08', 'status': 'awaiting-overall-review',
        'decisionRange': 'D001-D130', 'organizerDefaults': 'R01-R07',
        'applicationGenerated': False, 'applicationAcceptance': 'not-executed',
        'acceptanceCases': 84, 'sampleProjects': 2, 'sampleUsers': 6, 'sampleTasks': 10,
        'hashScope': 'all package files except manifest.json itself; archive hash is external',
        'files': [{'path': p.relative_to(PACKAGE).as_posix(), 'bytes': p.stat().st_size,
                   'sha256': hashlib.sha256(p.read_bytes()).hexdigest()} for p in files]
    }
    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    DELIVERY.mkdir(exist_ok=True)
    with zipfile.ZipFile(ARCHIVE, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in sorted(files + [MANIFEST]):
            entry = zipfile.ZipInfo(VERSION + '/' + path.relative_to(PACKAGE).as_posix(), (2026, 11, 8, 0, 0, 0))
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.external_attr = 0o100644 << 16
            archive.writestr(entry, path.read_bytes())
    with zipfile.ZipFile(ARCHIVE) as archive:
        check(archive.testzip() is None, 'archive integrity failure')
        check(set(archive.namelist()) == {VERSION + '/' + p.relative_to(PACKAGE).as_posix() for p in files + [MANIFEST]}, 'archive contents differ')
        for path in files + [MANIFEST]:
            check(archive.read(VERSION + '/' + path.relative_to(PACKAGE).as_posix()) == path.read_bytes(), 'archive data differs')
    digest = hashlib.sha256(ARCHIVE.read_bytes()).hexdigest()
    ARCHIVE.with_suffix('.zip.sha256').write_text(f'{digest}  {ARCHIVE.name}\n')
    print(json.dumps({'markdownChecked': markdown_count, 'decisions': 130, 'acceptanceCases': 84,
                      'packageFiles': len(files) + 1, 'archiveBytes': ARCHIVE.stat().st_size,
                      'archiveSha256': digest, 'archive': str(ARCHIVE)}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    build()
