-- ============================================================
-- 文献文化要素提取工具 - Supabase 建表脚本
-- 使用方法：登录 Supabase 控制台 -> SQL Editor -> 粘贴本文件全部内容 -> Run
-- 注意：应用通过 anon key 无法建表，必须手动执行本脚本一次
-- ============================================================

-- 用户表
create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  username text unique not null,
  password text not null,          -- 存储格式: salt$sha256(salt+password)
  email text default '',
  qq text default '',
  created_at timestamptz default now()
);

-- 用户自带DeepSeek API Key（加密存储；可选——不建此列仍可用，只是下次登录不能自动启用）
alter table public.users add column if not exists api_key text;

-- 留言表
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users(id) on delete cascade,
  username text not null,
  content text not null,
  created_at timestamptz default now()
);

-- 行级安全：演示项目放开匿名读写（生产环境请按需收紧策略）
alter table public.users enable row level security;
alter table public.messages enable row level security;

create policy "anon_all_users" on public.users
  for all using (true) with check (true);

create policy "anon_all_messages" on public.messages
  for all using (true) with check (true);
