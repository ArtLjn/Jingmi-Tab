"""验证账号隔离、重复请求和结果不确定时停止转发。"""
import json
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient
from conftest import FakeRepo, base_settings
from test_auth import register, auth
from server.app.main import create_app


class LedgerRepo(FakeRepo):
    def __init__(self):
        super().__init__()
        self.ledger = {}
        self.used = 0

    def reserve_rag_write(self, user_id, key, fingerprint, doc_id):
        old = self.ledger.get((user_id, key))
        if old and old['state'] == 'succeeded' and old['hash'] == fingerprint:
            return {'action': 'skip', 'doc_id': old['doc_id']}
        if old and old['state'] in ('pending', 'uncertain'):
            return {'action': 'blocked', 'doc_id': old['doc_id']}
        if self.used >= 500:
            return {'action': 'limited'}
        self.used += 1
        record = {'state': 'pending', 'hash': fingerprint, 'doc_id': old['doc_id'] if old else doc_id}
        self.ledger[user_id, key] = record
        return {'action': 'write', 'doc_id': record['doc_id'], 'replace': True}

    def finish_rag_write(self, user_id, key, fingerprint, succeeded):
        self.ledger[user_id, key]['state'] = 'succeeded' if succeeded else 'uncertain'


class Upstream:
    calls = []
    timeout = False

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass

    async def request(self, method, url, **kwargs):
        self.calls.append((method, url, kwargs))
        if method == 'DELETE':
            return httpx.Response(404)
        if self.timeout:
            raise httpx.ReadTimeout('响应丢失')
        return httpx.Response(200, json={'code': 'OK', 'data': {'ok': True}})


def fields(doc_id='device-page', text='正文', client='旧客户端'):
    return {k: (None, v) for k, v in {
        'collection': '伪造集合', 'doc_id': doc_id, 'text': text,
        'metadata_json': json.dumps({'canonical_url': 'https://example.com/a', 'client_id': client, 'captured_at': client})
    }.items()}


def setup():
    repo = LedgerRepo()
    client = TestClient(create_app(base_settings(), repo))
    token = register(client, 'gate-user').json()['data']['token']
    Upstream.calls = []
    Upstream.timeout = False
    return client, repo, auth(token)


def test_重复入库复用结果且重建客户端仍沿用原文档ID():
    client, repo, headers = setup()
    with patch('server.app.main.httpx.AsyncClient', Upstream):
        first = client.post('/api/rag/ingest', files=fields(), headers=headers)
        second = client.post('/api/rag/ingest', files=fields('new-device', client='新客户端'), headers=headers)
        assert first.status_code == second.status_code == 200
        assert second.json()['data']['doc_id'] == 'device-page'
        assert len([c for c in Upstream.calls if c[0] == 'POST']) == 1
        client = TestClient(create_app(base_settings(), repo))
        third = client.post('/api/rag/ingest', files=fields('after-restart'), headers=headers)
        assert third.status_code == 200
        assert repo.used == 1
        forwarded = Upstream.calls[1][2]['files']
        assert forwarded['collection'][1] != '伪造集合'


def test_回执丢失隔离任务后不重复写入():
    client, repo, headers = setup()
    Upstream.timeout = True
    with patch('server.app.main.httpx.AsyncClient', Upstream):
        assert client.post('/api/rag/ingest', files=fields(), headers=headers).status_code == 502
        count = len(Upstream.calls)
        assert client.post('/api/rag/ingest', files=fields(), headers=headers).status_code == 409
        assert len(Upstream.calls) == count
        assert next(iter(repo.ledger.values()))['state'] == 'uncertain'


def test_版本变化先清旧文档再写新版本():
    client, repo, headers = setup()
    with patch('server.app.main.httpx.AsyncClient', Upstream):
        assert client.post('/api/rag/ingest', files=fields(), headers=headers).status_code == 200
        assert client.post('/api/rag/ingest', files=fields(text='更新正文'), headers=headers).status_code == 200
    assert [c[0] for c in Upstream.calls] == ['DELETE', 'POST', 'DELETE', 'POST']
    assert repo.used == 2


def test_每日配额及非法入口不转发():
    client, repo, headers = setup()
    repo.used = 500
    with patch('server.app.main.httpx.AsyncClient', Upstream):
        assert client.post('/api/rag/ingest', files=fields(), headers=headers).status_code == 429
        assert client.post('/api/rag/other-write', json={}, headers=headers).status_code == 403
        assert client.post('/api/rag/ingest', json={}, headers=headers).status_code == 422
    assert Upstream.calls == []


def test_真实仓库SQL的持久记录配额及删除状态(monkeypatch):
    """以 SQLite 验证仓库 SQL 状态变化；MySQL 行锁仍需部署环境验收。"""
    import sqlite3
    from contextlib import contextmanager
    from server.app import repository

    connection = sqlite3.connect(':memory:')
    connection.row_factory = sqlite3.Row
    connection.executescript('''
        CREATE TABLE rag_writes(user_id INTEGER,page_key TEXT,payload_hash TEXT DEFAULT '',doc_id TEXT DEFAULT '',state TEXT DEFAULT 'new',updated_at TEXT,PRIMARY KEY(user_id,page_key));
        CREATE TABLE rag_daily(user_id INTEGER,usage_day TEXT,writes INTEGER DEFAULT 0,PRIMARY KEY(user_id,usage_day));
    ''')

    class Cursor:
        def execute(self, sql, params=()):
            sql = sql.replace('INSERT IGNORE', 'INSERT OR IGNORE').replace(' FOR UPDATE', '')
            sql = sql.replace('UTC_TIMESTAMP(3)', "datetime('now')").replace('UTC_DATE()', "date('now')").replace('%s', '?')
            self.cursor = connection.execute(sql, params)

        def fetchone(self):
            return self.cursor.fetchone()

    @contextmanager
    def transaction(settings):
        try:
            yield Cursor()
            connection.commit()
        except Exception:
            connection.rollback()
            raise

    monkeypatch.setattr(repository, 'transaction', transaction)
    repo = repository.BackupRepository(None)
    try:
        assert repo.reserve_rag_write(1, 'page', 'v1', 'old-id')['action'] == 'write'
        assert repo.reserve_rag_write(1, 'page', 'v1', 'new-id')['action'] == 'blocked'
        assert not repo.reserve_rag_delete(1, 'old-id')
        repo.finish_rag_write(1, 'page', 'v1', True)
        # 换一个仓库实例，保留同一数据库，模拟服务重启。
        repo = repository.BackupRepository(None)
        assert repo.reserve_rag_write(1, 'page', 'v1', 'new-id') == {'action': 'skip', 'doc_id': 'old-id'}
        assert repo.reserve_rag_write(2, 'page', 'v1', 'other-account')['action'] == 'write'
        assert repo.reserve_rag_delete(1, 'old-id')
        repo.finish_rag_delete(1, 'old-id', True)
        assert repo.reserve_rag_write(1, 'page', 'v1', 'new-id')['action'] == 'write'
        repo.finish_rag_write(1, 'page', 'v1', False)
        assert repo.reserve_rag_write(1, 'page', 'v2', 'new-id')['action'] == 'blocked'
        connection.execute('UPDATE rag_daily SET writes=500 WHERE user_id=1')
        connection.commit()
        assert repo.reserve_rag_write(1, 'another', 'v1', 'id')['action'] == 'limited'
    finally:
        connection.close()
