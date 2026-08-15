-- ============================================================
-- 文献文化要素提取工具 - Supabase 完整建表脚本（作者版）
-- 使用方法：登录 Supabase 控制台 -> SQL Editor -> 粘贴本文件全部内容 -> Run
-- 幂等：重复执行不报错（IF NOT EXISTS / IF NOT EXISTS列）
--
-- 重要说明：
-- 1) 本应用采用"应用内登录"（用户名+密码存于本表），不使用 Supabase Auth，
--    因此 auth.uid() 恒为空。你之前 messages 的删除策略
--    (auth.uid()::text = user_id::text) 永远不会匹配 -> 留言删除会静默失败。
--    本脚本改为应用层控制的放开策略（访问控制由 app.py 负责）。
-- 2) users.api_key 存的是【密文】（用服务端 SESSION_SECRET 加密），
--    请勿改动策略将其明文暴露。
-- ============================================================

-- ---------- 用户表（BIGSERIAL 主键，与你现有结构一致） ----------
CREATE TABLE IF NOT EXISTS users (
    id BIGSERIAL PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    email TEXT,
    qq TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 追加列（幂等；不建这些列功能降级但不崩溃）
ALTER TABLE users ADD COLUMN IF NOT EXISTS api_key TEXT;             -- 用户自带DeepSeek Key（密文）
ALTER TABLE users ADD COLUMN IF NOT EXISTS invite_until TIMESTAMPTZ; -- 邀请码有效期截止时间
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE; -- 管理员标记（可选）

-- ---------- 留言表 ----------
CREATE TABLE IF NOT EXISTS messages (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    username TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ---------- 提取结果表（原文+结果，供管理查看与"高分转回归基准"） ----------
CREATE TABLE IF NOT EXISTS extraction_results (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    username TEXT NOT NULL,
    book_name TEXT NOT NULL,
    file_name TEXT NOT NULL,
    entry_count INT,
    source_text TEXT,        -- 提取所用的原文（文本层/Word直接文本；OCR为纠正后文本）
    result_json JSONB,       -- 提取结果（条目数组）
    rating INT,              -- 用户评分 1-10（可选）
    feedback TEXT,           -- 用户意见（可选）
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ---------- 行级安全 ----------
-- 本应用用应用内登录（非Supabase Auth），故放开匿名读写，访问控制由应用层负责
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

-- users：注册(INSERT)/登录(SELECT)/更新Key与邀请码(UPDATE) 均允许
-- 说明：CREATE POLICY 不支持 IF NOT EXISTS，故用"先删后建"保证任意次数执行不报错
DROP POLICY IF EXISTS "anon all users" ON users;
CREATE POLICY "anon all users" ON users FOR ALL USING (true) WITH CHECK (true);

-- messages：读写删均允许（删除时应用层已按 user_id 约束；管理员可删任意）
DROP POLICY IF EXISTS "anon all messages" ON messages;
CREATE POLICY "anon all messages" ON messages FOR ALL USING (true) WITH CHECK (true);

-- extraction_results：读写均允许（访问控制由应用层负责）
DROP POLICY IF EXISTS "anon all extraction_results" ON extraction_results;
CREATE POLICY "anon all extraction_results" ON extraction_results FOR ALL USING (true) WITH CHECK (true);

-- 提示：若你之前执行过旧版脚本，重复执行本脚本即可（旧的窄策略会被新策略覆盖/共存，
-- 操作权限取并集，不会冲突）。
