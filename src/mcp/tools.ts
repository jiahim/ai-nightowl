/**
 * MCP 工具注册（m4-mcp）：把 nightowl 的能力暴露成 MCP 工具。
 *
 * 关键设计：不重复造逻辑，直接复用 HttpApi 的路由层（framework 无关的
 * 「发任务 / 查状态 / 推进」已经在那儿）。每个 MCP 工具只是把一次
 * HttpApi.handle 调用包成 MCP tool：入参透传给 HttpApi（宽松规整），
 * 返回 body 序列化成 text；HTTP 4xx/5xx 映射为 isError: true（工具级失败，
 * 不是协议错误）。
 */

import { HttpApi, type HttpRequest, type HttpResponse } from '../http/api.js';
import type { McpTool, ToolResult } from './protocol.js';

/** 把一次 HTTP 路由调用包成 MCP 工具结果 */
async function callApi(api: HttpApi, req: HttpRequest): Promise<ToolResult> {
  let res: HttpResponse;
  try {
    res = await api.handle(req);
  } catch (err) {
    return { isError: true, text: (err as Error).message };
  }
  const text = JSON.stringify(res.body, null, 2);
  return { isError: res.status >= 400, text };
}

/** 从 HttpApi 构建 MCP 工具集（复用 http 层的完整引擎装配） */
export function buildMcpTools(api: HttpApi): McpTool[] {
  return [
    {
      name: 'get_status',
      description: '查询 nightowl 当前状态：蓝图信息、各里程碑/子任务进度、整体完成度、checkpoint 数。',
      inputSchema: { type: 'object', properties: {} },
      handler: () => callApi(api, { method: 'GET', pathname: '/status', body: undefined }),
    },
    {
      name: 'get_cost',
      description: '查询累计 token 成本：调用次数、tokens 用量、原价/实付/节省（验证低谷时段折扣）。',
      inputSchema: { type: 'object', properties: {} },
      handler: () => callApi(api, { method: 'GET', pathname: '/cost', body: undefined }),
    },
    {
      name: 'get_runtime',
      description: '查询后台运行状态、最近 tick 报告和错误。',
      inputSchema: { type: 'object', properties: {} },
      handler: () => callApi(api, { method: 'GET', pathname: '/runtime', body: undefined }),
    },
    {
      name: 'get_plugins',
      description: '查询已加载的可信本地插件和 Provider 目录。',
      inputSchema: { type: 'object', properties: {} },
      handler: () => callApi(api, { method: 'GET', pathname: '/plugins', body: undefined }),
    },
    {
      name: 'submit_blueprint',
      description:
        '提交一个蓝图草稿（draft），nightowl 自动组装为结构化蓝图并落盘（会清空旧进度）。' +
        '必填 title 与 milestones（每项含 name、subtasks），其余字段可省。',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '蓝图标题（必填）' },
          description: { type: 'string', description: '蓝图描述' },
          constraints: { type: 'array', items: { type: 'string' }, description: '硬约束列表' },
          definitionOfDone: { type: 'string', description: '整体完成定义' },
          milestones: {
            type: 'array',
            description: '里程碑列表（必填，至少一个）',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: '里程碑名（必填）' },
                goal: { type: 'string' },
                acceptance: { type: 'array', items: { type: 'string' } },
                subtasks: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      name: { type: 'string', description: '子任务名（必填）' },
                      detail: { type: 'string' },
                      dependencies: { type: 'array', items: { type: 'string' } },
                      verdictKind: { type: 'string', enum: ['llm', 'check', 'manual'] },
                      check: { type: 'string', description: 'verdictKind=check 时的检查标识' },
                      criteria: { type: 'array', items: { type: 'string' } },
                    },
                  },
                },
              },
            },
          },
        },
        required: ['title', 'milestones'],
      },
      handler: (args) => callApi(api, { method: 'POST', pathname: '/blueprint', body: args }),
    },
    {
      name: 'submit_blueprint_raw',
      description:
        '提交一个已组装的完整 Blueprint（host 自定 id / 依赖，按 id 引用）。' +
        'nightowl 校验后落盘。必填 id、title、milestones。',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '蓝图 id（必填）' },
          title: { type: 'string', description: '蓝图标题（必填）' },
          description: { type: 'string' },
          constraints: { type: 'array', items: { type: 'string' } },
          definitionOfDone: { type: 'string' },
          milestones: {
            type: 'array',
            description: '里程碑列表（必填，至少一个）',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                goal: { type: 'string' },
                acceptance: { type: 'array', items: { type: 'string' } },
                subtasks: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      name: { type: 'string' },
                      detail: { type: 'string' },
                      dependencies: { type: 'array', items: { type: 'string' } },
                      verdict: {
                        type: 'object',
                        properties: {
                          kind: { type: 'string', enum: ['llm', 'check', 'manual'] },
                          prompt: { type: 'string' },
                          check: { type: 'string' },
                          criteria: { type: 'array', items: { type: 'string' } },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        required: ['id', 'title', 'milestones'],
      },
      handler: (args) => callApi(api, { method: 'POST', pathname: '/blueprint/raw', body: args }),
    },
    {
      name: 'tick',
      description: '推进一轮：挑一个可运行的子任务执行并判定，回写状态、落盘。无蓝图/无任务时返回 idle。',
      inputSchema: { type: 'object', properties: {} },
      handler: () => callApi(api, { method: 'POST', pathname: '/tick', body: {} }),
    },
    {
      name: 'run',
      description: '兼容名称：非阻塞启动后台推进，立即返回 operationId；用 get_runtime/stop 控制。',
      inputSchema: {
        type: 'object',
        properties: {
          maxTicks: { type: 'number', description: '最多推进轮数（正整数，可选）' },
        },
      },
      handler: (args) => callApi(api, { method: 'POST', pathname: '/runtime/start', body: args }),
    },
    {
      name: 'start',
      description: '非阻塞启动后台推进；立即返回 operationId，可用 get_runtime 查询。',
      inputSchema: {
        type: 'object',
        properties: { maxTicks: { type: 'number', description: '最多推进轮数（1–1000）' } },
      },
      handler: (args) => callApi(api, { method: 'POST', pathname: '/runtime/start', body: args }),
    },
    {
      name: 'stop',
      description: '停止后台运行继续领取任务；当前模型调用完成后收束。',
      inputSchema: { type: 'object', properties: {} },
      handler: () => callApi(api, { method: 'POST', pathname: '/runtime/stop', body: {} }),
    },
    {
      name: 'retry_subtask',
      description: '把一个 blocked 子任务显式恢复为 pending。',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: '子任务 id' } },
        required: ['id'],
      },
      handler: (args) => callApi(api, {
        method: 'POST',
        pathname: `/subtasks/${encodeURIComponent(String(args.id ?? ''))}/retry`,
        body: {},
      }),
    },
    {
      name: 'approve_subtask',
      description: '人工批准一个 manual verdict 子任务。',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '子任务 id' },
          note: { type: 'string', description: '批准说明' },
        },
        required: ['id'],
      },
      handler: (args) => callApi(api, {
        method: 'POST',
        pathname: `/subtasks/${encodeURIComponent(String(args.id ?? ''))}/approve`,
        body: { note: args.note },
      }),
    },
  ];
}
