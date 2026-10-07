import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { PROJECT_ROOT } from "../paths";
import { HttpError, type TaskService } from "../tasks/service";

export interface HealthInfo {
  ok: boolean;
  chain_id?: string;
  rpc_url?: string;
  escrow_address: string;
  verifier_address?: string;
  robot_adapter: string;
  robots: Record<string, string>;
  settlement_mode: "direct" | "cre";
  cre?: { trigger_url: string; forwarder: string };
  error?: string;
}

/**
 * REST API (all JSON, snake_case):
 *   GET  /                         demo UI (static files in web/; talks to this API only, no secrets)
 *   GET  /health
 *   POST /tasks                    create task            → 201 Task
 *   GET  /tasks                    list tasks
 *   GET  /tasks/:taskId            task + live on-chain escrow state
 *   POST /tasks/:taskId/fund       lock reward in escrow  → FUNDED
 *   POST /tasks/:taskId/start      run robot (mock or external simulator) → RUNNING
 *   POST /tasks/:taskId/proof      submit signed proof → verify → settle on-chain → SETTLED | FAILED
 *                                  (settlement mode "cre": 202, the Chainlink CRE workflow settles)
 *   POST /tasks/:taskId/settle     retry settlement (direct: VERIFIED task; cre: re-trigger the workflow)
 *
 * Chainlink CRE workflow endpoints (called by cre/machineproof-settlement):
 *   GET  /cre/tasks/:taskId/evidence   task spec + robot-signed proof for independent verification
 *   POST /cre/tasks/:taskId/result     the workflow's decision (informational; money state comes from chain)
 */
export function createApp(service: TaskService, health: () => Promise<HealthInfo>) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", async (_req, res) => {
    const info = await health();
    res.status(info.ok ? 200 : 503).json(info);
  });

  app.post("/tasks", (req, res) => {
    res.status(201).json(service.createTask(req.body));
  });

  app.get("/tasks", (_req, res) => {
    res.json(service.listTasks());
  });

  app.get("/tasks/:taskId", async (req, res) => {
    res.json(await service.getTaskView(req.params.taskId));
  });

  app.post("/tasks/:taskId/fund", async (req, res) => {
    res.json(await service.fundTask(req.params.taskId));
  });

  app.post("/tasks/:taskId/start", async (req, res) => {
    res.status(202).json(await service.startTask(req.params.taskId, req.body));
  });

  app.post("/tasks/:taskId/proof", async (req, res) => {
    const task = await service.submitProof(req.params.taskId, req.body);
    res.status(task.status === "PROOF_RECEIVED" ? 202 : 200).json(task);
  });

  app.post("/tasks/:taskId/settle", async (req, res) => {
    res.json(await service.settleTask(req.params.taskId));
  });

  app.get("/cre/tasks/:taskId/evidence", (req, res) => {
    res.json(service.getCreEvidence(req.params.taskId));
  });

  app.post("/cre/tasks/:taskId/result", async (req, res) => {
    const task = await service.recordCreResult(req.params.taskId, req.body);
    res.json({ task_id: task.task_id, status: task.status, cre: task.cre });
  });

  // Demo UI. Registered after the API routes so it can never shadow them.
  app.use(express.static(path.join(PROJECT_ROOT, "web"), { index: "index.html", maxAge: 0 }));

  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message, ...(err.details !== undefined ? { details: err.details } : {}) });
      return;
    }
    // body-parser errors (malformed JSON, payload too large) carry an HTTP status.
    const status = (err as { status?: number; type?: string }).status;
    if (typeof status === "number" && status >= 400 && status < 500) {
      const type = (err as { type?: string }).type;
      res.status(status).json({ error: type === "entity.parse.failed" ? "Malformed JSON body" : (err as Error).message });
      return;
    }
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}
