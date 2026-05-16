import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ASSIGNEE_AGENT_ID = "11111111-1111-4111-8111-111111111111";

const mockIssueService = vi.hoisted(() => ({
  assertCheckoutOwner: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  findMentionedAgents: vi.fn(),
  getRelationSummaries: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));
const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  resolveByReference: vi.fn(async (_companyId: string, raw: string) => ({
    ambiguous: false,
    agent: { id: raw },
  })),
}));
const mockIssueThreadInteractionService = vi.hoisted(() => ({
  expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
  expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
}));

vi.mock("../services/index.js", () => ({
  companyService: () => ({
    getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
  }),
  accessService: () => ({
    canUser: vi.fn(async () => true),
    hasPermission: vi.fn(async () => true),
  }),
  agentService: () => mockAgentService,
  documentService: () => ({}),
  executionWorkspaceService: () => ({}),
  feedbackService: () => ({
    listIssueVotesForUser: vi.fn(async () => []),
    saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
  }),
  goalService: () => ({}),
  heartbeatService: () => mockHeartbeatService,
  instanceSettingsService: () => ({
    get: vi.fn(async () => ({
      id: "instance-settings-1",
      general: {
        censorUsernameInLogs: false,
        feedbackDataSharingPreference: "prompt",
      },
    })),
    listCompanyIds: vi.fn(async () => ["company-1"]),
  }),
  issueApprovalService: () => ({}),
  issueReferenceService: () => ({
    deleteDocumentSource: async () => undefined,
    diffIssueReferenceSummary: () => ({
      addedReferencedIssues: [],
      removedReferencedIssues: [],
      currentReferencedIssues: [],
    }),
    emptySummary: () => ({ outbound: [], inbound: [] }),
    listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
    syncComment: async () => undefined,
    syncDocument: async () => undefined,
    syncIssue: async () => undefined,
  }),
  issueRecoveryActionService: () => ({
    getActiveForIssue: vi.fn(async () => null),
    listActiveForIssues: vi.fn(async () => new Map()),
  }),
  issueService: () => mockIssueService,
  issueThreadInteractionService: () => mockIssueThreadInteractionService,
  logActivity: vi.fn(async () => undefined),
  projectService: () => ({}),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({}),
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    companyService: () => ({
      getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
    }),
    accessService: () => ({
      canUser: vi.fn(async () => true),
      hasPermission: vi.fn(async () => true),
    }),
    agentService: () => mockAgentService,
    documentService: () => ({}),
    executionWorkspaceService: () => ({}),
    feedbackService: () => ({
      listIssueVotesForUser: vi.fn(async () => []),
      saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
    }),
    goalService: () => ({}),
    heartbeatService: () => mockHeartbeatService,
    instanceSettingsService: () => ({
      get: vi.fn(async () => ({
        id: "instance-settings-1",
        general: {
          censorUsernameInLogs: false,
          feedbackDataSharingPreference: "prompt",
        },
      })),
      listCompanyIds: vi.fn(async () => ["company-1"]),
    }),
    issueApprovalService: () => ({}),
    issueReferenceService: () => ({
      deleteDocumentSource: async () => undefined,
      diffIssueReferenceSummary: () => ({
        addedReferencedIssues: [],
        removedReferencedIssues: [],
        currentReferencedIssues: [],
      }),
      emptySummary: () => ({ outbound: [], inbound: [] }),
      listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
      syncComment: async () => undefined,
      syncDocument: async () => undefined,
      syncIssue: async () => undefined,
    }),
    issueRecoveryActionService: () => ({
      getActiveForIssue: vi.fn(async () => null),
      listActiveForIssues: vi.fn(async () => new Map()),
    }),
    issueService: () => mockIssueService,
    issueThreadInteractionService: () => mockIssueThreadInteractionService,
    logActivity: vi.fn(async () => undefined),
    projectService: () => ({}),
    routineService: () => ({
      syncRunStatusForIssue: vi.fn(async () => undefined),
    }),
    workProductService: () => ({}),
  }));
}

async function createApp(actor: Record<string, unknown> = {
  type: "board",
  userId: "local-board",
  companyIds: ["company-1"],
  source: "local_implicit",
  isInstanceAdmin: false,
}) {
  const [{ errorHandler }, { issueRoutes }] = await Promise.all([
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    companyId: "company-1",
    status: "todo",
    priority: "medium",
    projectId: null,
    goalId: null,
    parentId: null,
    assigneeAgentId: null,
    assigneeUserId: "local-board",
    createdByUserId: "local-board",
    identifier: "PAP-999",
    title: "Wake test",
    executionPolicy: null,
    executionState: null,
    hiddenAt: null,
    ...overrides,
  };
}

describe("issue update comment wakeups", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockAgentService.getById.mockResolvedValue(null);
  });

  it("includes the new comment in assignment wakes from issue updates", async () => {
    const existing = makeIssue();
    const updated = makeIssue({
      assigneeAgentId: ASSIGNEE_AGENT_ID,
      assigneeUserId: null,
    });
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue(updated);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-1",
      issueId: existing.id,
      companyId: existing.companyId,
      body: "write the whole thing",
    });

    const res = await request(await createApp())
      .patch(`/api/issues/${existing.id}`)
      .send({
        assigneeAgentId: ASSIGNEE_AGENT_ID,
        assigneeUserId: null,
        comment: "write the whole thing",
      });

    expect(res.status).toBe(200);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      ASSIGNEE_AGENT_ID,
      expect.objectContaining({
        source: "assignment",
        reason: "issue_assigned",
        payload: expect.objectContaining({
          issueId: existing.id,
          commentId: "comment-1",
          mutation: "update",
        }),
        contextSnapshot: expect.objectContaining({
          issueId: existing.id,
          taskId: existing.id,
          commentId: "comment-1",
          wakeCommentId: "comment-1",
          source: "issue.update",
        }),
      }),
    );
  });

  it("wakes the assignee on comment-only issue updates", async () => {
    const existing = makeIssue({
      assigneeAgentId: ASSIGNEE_AGENT_ID,
      assigneeUserId: null,
      status: "in_progress",
    });
    const updated = { ...existing };
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue(updated);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-2",
      issueId: existing.id,
      companyId: existing.companyId,
      body: "please revise this",
    });

    const res = await request(await createApp())
      .patch(`/api/issues/${existing.id}`)
      .send({
        comment: "please revise this",
      });

    expect(res.status).toBe(200);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      ASSIGNEE_AGENT_ID,
      expect.objectContaining({
        source: "automation",
        reason: "issue_commented",
        payload: expect.objectContaining({
          issueId: existing.id,
          commentId: "comment-2",
          mutation: "comment",
        }),
        contextSnapshot: expect.objectContaining({
          issueId: existing.id,
          taskId: existing.id,
          commentId: "comment-2",
          wakeCommentId: "comment-2",
          wakeReason: "issue_commented",
          source: "issue.comment",
        }),
      }),
    );
  });

  it("rejects Scraper QA PASS close comments with THREE-LAYER header but missing layer evidence", async () => {
    const existing = makeIssue({
      assigneeAgentId: ASSIGNEE_AGENT_ID,
      assigneeUserId: null,
      status: "in_progress",
    });
    mockIssueService.getById.mockResolvedValue(existing);

    const res = await request(await createApp({
      type: "agent",
      agentId: ASSIGNEE_AGENT_ID,
      companyId: existing.companyId,
      source: "agent_key",
      runId: "22222222-2222-4222-8222-222222222222",
    }))
      .patch(`/api/issues/${existing.id}`)
      .send({
        status: "done",
        comment: "THREE-LAYER QA REPORT\nLooks good overall.",
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("qa_three_layer.py evidence");
    expect(res.body.missingEvidence).toEqual(expect.arrayContaining([
      "Layer 1 PASS line",
      "Layer 2 PASS line",
      "Layer 3 PASS line",
      "`Overall: PASSED` line",
    ]));
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("allows Scraper QA PASS close comments with qa_three_layer.py evidence", async () => {
    const existing = makeIssue({
      assigneeAgentId: ASSIGNEE_AGENT_ID,
      assigneeUserId: null,
      status: "in_progress",
    });
    const updated = { ...existing, status: "done" };
    const comment = [
      "QA PASSED — all 3 stages.",
      "",
      "Command: `python scraper/qa_three_layer.py --csv competitor_products.csv --collection-id 33333333-3333-4333-8333-333333333333`",
      "[qa_three_layer] CSV: competitor_products.csv (6 rows)",
      "[qa_three_layer] Collection: 33333333-3333-4333-8333-333333333333",
      "",
      "============================================================",
      "  THREE-LAYER QA REPORT",
      "  Collection: 33333333-3333-4333-8333-333333333333",
      "============================================================",
      "",
      "  Layer 1 (Scraper CSV):   [PASS]",
      "  Layer 2 (DB parity):     [PASS]",
      "  Layer 3 (WebUI render):  [PASS]",
      "",
      "  Overall: PASSED",
    ].join("\n");
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue(updated);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-pass",
      issueId: existing.id,
      companyId: existing.companyId,
      body: comment,
    });
    mockAgentService.getById.mockResolvedValue({
      id: ASSIGNEE_AGENT_ID,
      companyId: existing.companyId,
      name: "Scraper QA",
      role: "Scraper QA",
    });

    const res = await request(await createApp({
      type: "agent",
      agentId: ASSIGNEE_AGENT_ID,
      companyId: existing.companyId,
      source: "agent_key",
      runId: "22222222-2222-4222-8222-222222222222",
    }))
      .patch(`/api/issues/${existing.id}`)
      .send({
        status: "done",
        comment,
      });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      existing.id,
      expect.objectContaining({ status: "done", actorAgentId: ASSIGNEE_AGENT_ID }),
    );
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      existing.id,
      comment,
      expect.objectContaining({
        agentId: ASSIGNEE_AGENT_ID,
        runId: "22222222-2222-4222-8222-222222222222",
      }),
    );
  });
});

describe("scraper QA close gate", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
  });

  it("accepts a valid scoped scraper QA PASS comment", async () => {
    const existing = makeIssue({ assigneeAgentId: ASSIGNEE_AGENT_ID, assigneeUserId: null, status: "in_progress" });
    const updated = { ...existing, status: "done" };
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue(updated);
    mockIssueService.addComment.mockResolvedValue({ id: "comment-3", issueId: existing.id, companyId: existing.companyId, body: "" });

    const scopedPassComment = [
      "[scoped-scraper-qa] NORDSTROM repair confirmed.",
      "verify_scrape.py cf9faebf => OVERALL: PASS",
      "DB state: 19 rows, one variant_group_id, color_count=19, variant_count_on_page=19",
      "UI artifact: scraper/.qa-artifacts/ver531-ilva-nordstrom-drawer.png",
    ].join("\n");

    const res = await request(await createApp())
      .patch(`/api/issues/${existing.id}`)
      .send({ status: "done", comment: scopedPassComment });

    expect(res.status).toBe(200);
  });

  it("rejects a scoped scraper QA PASS comment missing UI artifact", async () => {
    const existing = makeIssue({ assigneeAgentId: ASSIGNEE_AGENT_ID, assigneeUserId: null, status: "in_progress" });
    mockIssueService.getById.mockResolvedValue(existing);

    const incompleteComment = [
      "[scoped-scraper-qa] NORDSTROM repair confirmed.",
      "verify_scrape.py cf9faebf => OVERALL: PASS",
      "DB state: 19 rows, one variant_group_id, color_count=19",
      // UI artifact missing
    ].join("\n");

    const res = await request(await createApp())
      .patch(`/api/issues/${existing.id}`)
      .send({ status: "done", comment: incompleteComment });

    expect(res.status).toBe(422);
    expect(res.body.missingEvidence).toContain(
      "UI artifact reference (screenshot path, Web UI evidence, or drawer confirmation)",
    );
  });

  it("accepts a valid full three-layer QA PASS comment", async () => {
    const existing = makeIssue({ assigneeAgentId: ASSIGNEE_AGENT_ID, assigneeUserId: null, status: "in_progress" });
    const updated = { ...existing, status: "done" };
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue(updated);
    mockIssueService.addComment.mockResolvedValue({ id: "comment-4", issueId: existing.id, companyId: existing.companyId, body: "" });

    const fullPassComment = [
      "THREE-LAYER QA REPORT",
      "Layer 1 (Scraper CSV): PASS",
      "Layer 2 (DB parity): PASS",
      "Layer 3 (WebUI render): PASS",
      "Overall: PASSED",
    ].join("\n");

    const res = await request(await createApp())
      .patch(`/api/issues/${existing.id}`)
      .send({ status: "done", comment: fullPassComment });

    expect(res.status).toBe(200);
  });

  it("rejects a full QA PASS comment missing three-layer report header", async () => {
    const existing = makeIssue({ assigneeAgentId: ASSIGNEE_AGENT_ID, assigneeUserId: null, status: "in_progress" });
    mockIssueService.getById.mockResolvedValue(existing);

    // Has the scoped marker? No. Has THREE-LAYER? No. Gate fires only on scraper-qa markers.
    // Use a comment that triggers the gate (has THREE-LAYER in a broken form to trigger detection
    // but not in the right format — actually gate fires on THREE-LAYER QA REPORT header,
    // so if absent it doesn't trigger. Test full path: manually include the header but miss layers.
    const brokenFullComment = [
      "THREE-LAYER QA REPORT",
      // Missing Layer 1/2/3 PASS lines and Overall: PASSED
      "Layer 1: FAIL",
      "Layer 2: FAIL",
      "Overall: FAILED",
    ].join("\n");

    const res = await request(await createApp())
      .patch(`/api/issues/${existing.id}`)
      .send({ status: "done", comment: brokenFullComment });

    expect(res.status).toBe(422);
    expect(res.body.missingEvidence).toContain("Layer 1 PASS line");
    expect(res.body.missingEvidence).toContain("Layer 2 PASS line");
    expect(res.body.missingEvidence).toContain("Layer 3 PASS line");
  });
});
