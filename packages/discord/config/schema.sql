-- Queue table for managing message tasks
create table if not exists queue (
  id uuid default uuid_generate_v4() primary key,
  status text not null,
  task_type text not null,
  payload jsonb,
  created_at timestamp with time zone default timezone('utc'::text, now()),
  completed_at timestamp with time zone,
  responded boolean default false,
  error_message text
);

-- Memory table for storing conversation context
create table if not exists memory (
  id uuid default uuid_generate_v4() primary key,
  user_id text not null,
  guild_id text,
  context text,
  insight text,
  created_at timestamp with time zone default timezone('utc'::text, now()),
  expires_at timestamp with time zone
); 