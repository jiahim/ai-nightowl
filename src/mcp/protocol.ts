/**
 * MCP 协议层（m4-mcp）：JSON-RPC 2.0 + Model Context Protocol 核心。
 *
 * 这是「框架无关」的 MCP 路由 / 分发层：只理解 JSON-RPC 消息和 MCP 工具
 * 语义，完全不碰 socket / stdio / HTTP。真正的接线（stdio transport）在
 * server.ts，工具注册在 tools.ts。
 *
 * 协议要点（对齐 MCP spec 2025-06-18 / 2024-11-05 兼容子集）：
 *   - 传输：stdio，一行一个 JSON-RPC 消息，禁止消息内嵌换行（JSON.stringify
 *     输出单行天然满足；工具返回的 text 里若含换行会被再序列化时转义为 \n）
 *   - 请求带 id，响应回同 id；通知（无 id）不响应
 *   - 握手：initialize（客户端报 protocolVersion → 服务器回 serverInfo +
 *     capabilities + 协商后的 protocolVersion）→ notifications/initialized
 *   - 工具：tools/list（发现工具）、tools/call（执行工具，结果包 content）
 *   - 工具执行失败用 isError: true 返回（协议级错误才用 JSON-RPC error）
 */

// ---------- JSON-RPC 2.0 错误码 ----------

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

/** 支持协商的协议版本（新→旧） */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2024-11-05'];

// ---------- 消息形状 ----------

/** JSON-RPC 响应（成功或错误，二选一） */
export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** MCP 服务器自述信息 */
export interface ServerInfo {
  name: string;
  version: string;
}

/** 工具的输入 schema（JSON Schema，仅作元数据，不参与校验） */
export interface ToolInputSchema {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
}

/** 工具执行结果：text 是返回给客户端的内容，isError 标记工具级失败 */
export interface ToolResult {
  isError: boolean;
  text: string;
}

/** MCP 工具：名字 + 描述 + 输入 schema + 处理器 */
export interface McpTool {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}

export interface McpRouterOptions {
  tools: McpTool[];
  serverInfo: ServerInfo;
}

/**
 * MCP 路由 / 分发器（无 IO）。
 *
 * 输入一条已解析的 JSON 消息（unknown），输出一条 JSON-RPC 响应对象
 * （或 null = 通知 / 非法响应，无需回写）。transport 层只负责读一行、
 * 调 dispatch、把非 null 结果 JSON.stringify 写一行。
 */
export class McpRouter {
  private readonly tools: Map<string, McpTool>;
  private readonly serverInfo: ServerInfo;
  private readonly latestProtocol: string;

  constructor(options: McpRouterOptions) {
    this.tools = new Map(options.tools.map((t) => [t.name, t]));
    this.serverInfo = options.serverInfo;
    this.latestProtocol = SUPPORTED_PROTOCOL_VERSIONS[0];
  }

  /** 暴露已注册工具名（测试 / 自省用） */
  toolNames(): string[] {
    return [...this.tools.keys()];
  }

  /**
   * 处理一条来自客户端的消息，返回要回写的响应（null 表示不回写）。
   */
  async dispatch(raw: unknown): Promise<JsonRpcResponse | null> {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return this.invalidRequest(null);
    }
    const msg = raw as Record<string, unknown>;
    if (msg.jsonrpc !== '2.0') {
      return this.invalidRequest(extractId(msg));
    }

    // 服务器不该收到响应 / 错误消息（无 method），忽略
    if (typeof msg.method !== 'string') {
      return null;
    }

    const method = msg.method;
    const params = msg.params;
    const hasId = Object.prototype.hasOwnProperty.call(msg, 'id');
    const id = extractId(msg);
    if (hasId && id === null && msg.id !== null) return this.invalidRequest(null);

    // 通知：无 id，不响应
    if (!hasId) {
      this.handleNotification(method);
      return null;
    }

    try {
      const result = await this.handleRequest(method, params);
      return { jsonrpc: '2.0', id, result };
    } catch (err) {
      const e = err as { code?: number; message?: string };
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: e.code ?? INTERNAL_ERROR,
          message: e.message ?? 'internal error',
        },
      };
    }
  }

  private async handleRequest(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return this.initialize(params);
      case 'ping':
        return {};
      case 'tools/list':
        return this.listTools();
      case 'tools/call':
        return this.callTool(params);
      default:
        throw rpcError(METHOD_NOT_FOUND, `未知方法：${method}`);
    }
  }

  private handleNotification(method: string): void {
    // notifications/initialized 是客户端握手完成信号，无需动作；
    // notifications/cancelled 等未来按需处理。此处显式 void 消除未用告警。
    void method;
  }

  /** 握手：协商协议版本，回 serverInfo + capabilities */
  private initialize(params: unknown): unknown {
    const p = asObject(params);
    const requested = typeof p.protocolVersion === 'string' ? p.protocolVersion : undefined;
    const protocolVersion =
      requested && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : this.latestProtocol;
    return {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: this.serverInfo,
      instructions:
        'ai-nightowl 本地任务编排服务。可查询状态/成本/插件，提交蓝图，' +
        '单步或后台运行，并显式重试 blocked、批准 manual 子任务。',
    };
  }

  private listTools(): unknown {
    return {
      tools: [...this.tools.values()].map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    };
  }

  private async callTool(params: unknown): Promise<unknown> {
    const p = asObject(params);
    const name = typeof p.name === 'string' ? p.name : '';
    const tool = this.tools.get(name);
    if (!tool) {
      throw rpcError(INVALID_PARAMS, `未知工具：${name}`);
    }
    const args = asObject(p.arguments);
    for (const field of tool.inputSchema.required ?? []) {
      if (!(field in args)) throw rpcError(INVALID_PARAMS, `工具 ${name} 缺少必填参数：${field}`);
    }

    let result: ToolResult;
    try {
      result = await tool.handler(args);
    } catch (err) {
      result = { isError: true, text: (err as Error).message };
    }

    return {
      content: [{ type: 'text', text: result.text }],
      isError: result.isError,
    };
  }

  private invalidRequest(id: number | string | null): JsonRpcResponse {
    return {
      jsonrpc: '2.0',
      id,
      error: { code: INVALID_REQUEST, message: '无效请求：非法 JSON-RPC 消息' },
    };
  }
}

// ---------- 工具函数 ----------

/** 从消息里取 id（number/string），否则 null（通知 / 无 id） */
function extractId(msg: Record<string, unknown>): number | string | null {
  const id = msg.id;
  return typeof id === 'number' || typeof id === 'string' || id === null ? id : null;
}

function asObject(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
}

/** 构造带 code 的 JSON-RPC 业务错误（由 dispatch 捕获转成 error 响应） */
function rpcError(code: number, message: string): Error {
  const err = new Error(message) as Error & { code?: number };
  err.code = code;
  return err;
}
