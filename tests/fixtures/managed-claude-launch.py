"""Emit actual lifecycle producer argv/env from the maintained private FastAPI/SQLite fixture. Never starts a host/runtime."""
import json
import pathlib
import sqlite3
import sys

repo, workspace, old = sys.argv[1:4]
sys.path.insert(0, str(pathlib.Path(repo).resolve()))
import fastapi
from service.tests._base import FastApiTestCase
from service.tests.defined_agents import define, publish
from service.tests.published_state import publish as publish_state

ENV = {"environment_id": "fixture-env", "machine_id": "fixture-machine", "bridge_id": "fixture-bridge"}
HOST = {"bridgeId": ENV["bridge_id"], "machineId": ENV["machine_id"]}
BASE = "/api/v1/environments/fixture-env"

class Caller(FastApiTestCase):
    def ok(self, response):
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def sql(self, text, args=()):
        db = sqlite3.connect(self._db_path)
        try:
            db.row_factory = sqlite3.Row
            rows = [dict(row) for row in db.execute(text, args)]
            db.commit()
            return rows
        finally:
            db.close()

    def prepared(self, mode):
        self.ok(self.client.post("/api/v1/environments/heartbeat", json={
            "id": ENV["environment_id"], "machineId": ENV["machine_id"], "bridgeId": ENV["bridge_id"],
            "os": "win32", "kind": "win32", "cwdRoots": [workspace], "runtimes": [{"runtime": "claude-code", "available": True}],
            "metadata": {"terminal": True, "pty": True, "terminalRuntimes": ["claude-code"]}}))
        if mode == "new-definition":
            publish(self, **ENV)
            creation = self.ok(self.client.post("/api/v1/spawn-requests", json={
                "createdBy": "fixture", "environmentId": ENV["environment_id"], "agentId": "coder", "role": "coder",
                "runtime": "claude-code", "workspace": workspace, "resumePolicy": "native_first"}))["definitionRequest"]
            self.ok(self.client.post(f"{BASE}/definition-requests/claim", json=HOST))
            self.ok(self.client.post(f"{BASE}/definition-requests/{creation['id']}/result", json={
                **HOST, "status": "done", "resultIncarnation": 1, "resultRevision": 1}))
            entry = define(self, "coder", workspace=workspace, **ENV)
        else:
            entry = define(self, "coder", workspace=workspace, **ENV)
            self.sql("UPDATE agents SET session_handle = ?, runtime_state = '{}' WHERE id = 'coder'", (old,))
            if mode == "handoff":
                publish_state(self, ENV["machine_id"], {"coder": ("L1", "idle")})
                self.ok(self.client.post("/api/v1/spawn-requests", json={
                    "createdBy": "fixture", "environmentId": ENV["environment_id"], "agentId": "coder", "runtime": "claude-code",
                    "workspace": workspace, "resumePolicy": "fresh_context", "initialMessage": "private handoff brief",
                    "metadata": {"compactMode": "handoff", "compactedFromAgentId": "coder", "compactedFromSessionId": old, "sameAgentId": True}}))
            else:
                self.ok(self.client.post("/api/v1/agents/coder/lifecycle-requests", json={
                    "requestId": "fixture-request", "action": "start", "requestedBy": "fixture", "expectedLifetime": None,
                    "freshContext": mode == "reset"}))
        requests = self.ok(self.client.post(f"{BASE}/lifecycle-requests/claim", json=HOST))["requests"]
        self.assertEqual(len(requests), 1)
        launch = self.ok(self.client.post(f"{BASE}/lifecycle-requests/{requests[0]['id']}/launch", json=HOST))["launch"]
        return {"mode": mode, "entry": entry, "launch": launch}

Caller.setUpClass()
try:
    results = []
    for mode in ("reset", "handoff", "new-definition", "resume"):
        caller = Caller()
        caller.setUp()
        try:
            results.append(caller.prepared(mode))
        finally:
            caller.tearDown()
    print(json.dumps({"interpreter": sys.executable, "fastapiVersion": fastapi.__version__, "launches": results}))
finally:
    Caller.tearDownClass()
