import json

prompt = """【nightowl 心跳·无人值守】你是 sam，定时推进 ai-nightowl 项目开发。第一步：读 MEMORY.md 的 ai-nightowl 段、ai-nightowl/docs/progress.json、ai-nightowl/docs/blueprint.md，记下各里程碑旧状态。第二步：找当前里程碑下依赖已满足的 pending 子任务，若有则实现它（写代码到 ai-nightowl/src/），执行 cd /home/sam/.qwenpaw/workspaces/sam/nightowl && npx tsc --noEmit 验证零错误，更新 progress.json（标 done、推进里程碑、更新 last_heartbeat）并追加 heartbeat.log，一次只推进一个子任务。第三步：推送与停止——推送统一用 write_file 写 /tmp/notify.json（body：channel=wechat、target_user=微信用户#M+o=、target_session=wechat:o9cq8063trZAYWLhWHxMElPyyvgs@im.wechat、text 见下），再执行 curl -sS -X POST http://127.0.0.1:8088/api/messages/send -H 'Content-Type: application/json' -H 'X-Agent-Id: sam' --data @/tmp/notify.json；停止心跳统一执行 qwenpaw cron update 1b6a587f-1f96-4326-a215-4699c098e731 --no-enabled --agent-id sam 和 qwenpaw cron update 095933b6-f3d3-4129-bc1a-6e116b62084c --no-enabled --agent-id sam。（a）若所有里程碑已 done：text="🎉 ai-nightowl 全部完成"，推送后停止心跳。（b）若存在 blocker（所有 pending 子任务都因缺用户拍板无法推进）且该 blocker 在 progress.json 无 notified 标记：text="⚠️ ai-nightowl 卡点：<blocker 描述>，等你拍板<选项>"，推送后停止心跳，并在 progress.json 给该 blocker 加 "notified": true、记 heartbeat.log；若已有 notified 标记则不再重复推送。（c）否则，若本次推进导致某里程碑从 pending/in-progress 变为 done：text="🎉 ai-nightowl 里程碑 <名> 完成，进度 <n>/5"，仅推送不停心跳。禁止 rm -rf/kill/改系统配置，改 src 前先备份。超时会被取消，宁可少做也要落盘状态。"""

def build_spec(name, cron):
    return {
        "id": "",
        "name": name,
        "enabled": True,
        "schedule": {"type": "cron", "cron": cron, "timezone": "Asia/Shanghai"},
        "task_type": "agent",
        "request": {"input": [{"role": "user", "type": "message", "content": [{"type": "text", "text": prompt}]}]},
        "dispatch": {"type": "channel", "channel": "console", "target": {"user_id": "default", "session_id": ""}, "mode": "stream", "silent": False, "meta": {}},
        "runtime": {"share_session": False, "max_concurrency": 1, "timeout_seconds": 1800, "misfire_grace_seconds": 600, "tool_safety": False},
        "meta": {},
    }

base = "/home/sam/.qwenpaw/workspaces/sam/ai-nightowl/docs/"
with open(base + "cron-evening.json", "w", encoding="utf-8") as f:
    json.dump(build_spec("nightowl-heartbeat-evening", "*/20 18-23 * * *"), f, ensure_ascii=False, indent=2)
with open(base + "cron-night.json", "w", encoding="utf-8") as f:
    json.dump(build_spec("nightowl-heartbeat-night", "*/20 0-8 * * *"), f, ensure_ascii=False, indent=2)
print("specs written")
