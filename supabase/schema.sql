-- Run this script once in Supabase SQL Editor.
-- Student-facing quiz delivery and scoring happen through SECURITY DEFINER RPCs,
-- so correct answers are never selected by the browser.

create or replace function public.valid_question_options(p_options jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when jsonb_typeof(p_options) <> 'array' then false
    when jsonb_array_length(p_options) <> 4 then false
    else not exists (
      select 1
      from jsonb_array_elements(p_options) as item(value)
      where jsonb_typeof(item.value) <> 'string'
         or char_length(item.value #>> '{}') not between 1 and 250
    )
  end;
$$;
revoke all on function public.valid_question_options(jsonb) from public;
grant execute on function public.valid_question_options(jsonb) to authenticated;

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default 'Ученик' check (char_length(display_name) between 1 and 80),
  role text not null default 'student' check (role in ('student', 'teacher')),
  created_at timestamptz not null default now()
);

create table if not exists public.quizzes (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 120),
  access_code text not null unique check (access_code ~ '^[A-HJ-NP-Z2-9]{6}$'),
  is_published boolean not null default false,
  duration_minutes integer not null default 30 check (duration_minutes between 1 and 300),
  created_at timestamptz not null default now()
);

create table if not exists public.questions (
  id uuid primary key default gen_random_uuid(),
  quiz_id uuid not null references public.quizzes (id) on delete cascade,
  position integer not null check (position > 0),
  prompt text not null check (char_length(prompt) between 1 and 500),
  options jsonb not null check (public.valid_question_options(options)),
  correct_index smallint not null check (correct_index between 0 and 3),
  unique (quiz_id, position)
);

create table if not exists public.attempts (
  id uuid primary key default gen_random_uuid(),
  quiz_id uuid not null references public.quizzes (id) on delete cascade,
  student_id uuid not null references public.profiles (id) on delete cascade,
  attempt_number smallint not null check (attempt_number between 1 and 2),
  status text not null default 'in_progress' check (status in ('in_progress', 'submitted', 'locked')),
  answers jsonb not null default '{}'::jsonb check (jsonb_typeof(answers) = 'object'),
  focus_violations smallint not null default 0 check (focus_violations between 0 and 2),
  correct_count integer,
  question_count integer not null check (question_count > 0),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (quiz_id, student_id, attempt_number)
);

create index if not exists attempts_student_quiz_idx on public.attempts (student_id, quiz_id);
create index if not exists questions_quiz_position_idx on public.questions (quiz_id, position);

create or replace function public.create_student_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name, role)
  values (
    new.id,
    coalesce(nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''), 'Ученик'),
    'student'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_profile on auth.users;
create trigger on_auth_user_created_profile
  after insert on auth.users
  for each row execute function public.create_student_profile();

create or replace function public.is_teacher()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid()) and p.role = 'teacher'
  );
$$;

revoke all on function public.is_teacher() from public;
grant execute on function public.is_teacher() to authenticated;

create or replace function public.student_quiz_list()
returns table (
  quiz_id uuid,
  title text,
  is_published boolean,
  question_count bigint,
  duration_minutes integer,
  attempts_used bigint,
  access_code text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null or not exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid()) and p.role = 'student'
  ) then
    raise exception 'Только ученик может просматривать список тестов.';
  end if;

  return query
  select q.id,
         q.title,
         q.is_published,
         (select count(*) from public.questions qs where qs.quiz_id = q.id),
         q.duration_minutes,
         (select count(*) from public.attempts a
          where a.quiz_id = q.id and a.student_id = (select auth.uid())),
         case when q.is_published then q.access_code else null end
  from public.quizzes q
  order by q.created_at desc;
end;
$$;

revoke all on function public.student_quiz_list() from public;
grant execute on function public.student_quiz_list() to authenticated;

create or replace function public.save_quiz_answer(
  p_attempt_id uuid,
  p_question_id uuid,
  p_answer smallint
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  attempt_row public.attempts%rowtype;
  quiz_duration integer;
begin
  if p_answer is null or p_answer not between 0 and 3 then
    raise exception 'Выбран неверный вариант ответа.';
  end if;

  select * into attempt_row
  from public.attempts a
  where a.id = p_attempt_id and a.student_id = (select auth.uid())
  for update;
  if not found or attempt_row.status <> 'in_progress' then
    raise exception 'Активная попытка не найдена.';
  end if;
  if not exists (
    select 1 from public.questions q
    where q.id = p_question_id and q.quiz_id = attempt_row.quiz_id
  ) then
    raise exception 'Вопрос не относится к этой попытке.';
  end if;

  select q.duration_minutes into quiz_duration
  from public.quizzes q where q.id = attempt_row.quiz_id;
  if clock_timestamp() >= attempt_row.started_at + make_interval(mins => quiz_duration) then
    raise exception 'Время на тест закончилось.';
  end if;

  update public.attempts
  set answers = jsonb_set(answers, array[p_question_id::text], to_jsonb(p_answer), true)
  where id = p_attempt_id;
end;
$$;

revoke all on function public.save_quiz_answer(uuid, uuid, smallint) from public;
grant execute on function public.save_quiz_answer(uuid, uuid, smallint) to authenticated;

alter table public.profiles enable row level security;
alter table public.quizzes enable row level security;
alter table public.questions enable row level security;
alter table public.attempts enable row level security;

revoke all on public.profiles, public.quizzes, public.questions, public.attempts from anon, public;

drop policy if exists "profiles_select_self" on public.profiles;
create policy "profiles_select_self" on public.profiles
  for select to authenticated using (id = (select auth.uid()));
drop policy if exists "profiles_update_name_self" on public.profiles;
create policy "profiles_update_name_self" on public.profiles
  for update to authenticated using (id = (select auth.uid()))
  with check (id = (select auth.uid()));
revoke update on public.profiles from authenticated;
grant update (display_name) on public.profiles to authenticated;

drop policy if exists "teacher_select_own_quizzes" on public.quizzes;
create policy "teacher_select_own_quizzes" on public.quizzes
  for select to authenticated using (owner_id = (select auth.uid()) and public.is_teacher());
drop policy if exists "teacher_insert_own_quizzes" on public.quizzes;
create policy "teacher_insert_own_quizzes" on public.quizzes
  for insert to authenticated with check (owner_id = (select auth.uid()) and public.is_teacher());
drop policy if exists "teacher_update_own_quizzes" on public.quizzes;
create policy "teacher_update_own_quizzes" on public.quizzes
  for update to authenticated using (owner_id = (select auth.uid()) and public.is_teacher())
  with check (owner_id = (select auth.uid()) and public.is_teacher());
drop policy if exists "teacher_delete_own_quizzes" on public.quizzes;
create policy "teacher_delete_own_quizzes" on public.quizzes
  for delete to authenticated using (owner_id = (select auth.uid()) and public.is_teacher());

drop policy if exists "teacher_manage_quiz_questions" on public.questions;
create policy "teacher_manage_quiz_questions" on public.questions
  for all to authenticated
  using (public.is_teacher() and exists (
    select 1 from public.quizzes q
    where q.id = quiz_id and q.owner_id = (select auth.uid())
  ))
  with check (public.is_teacher() and exists (
    select 1 from public.quizzes q
    where q.id = quiz_id and q.owner_id = (select auth.uid())
  ));

drop policy if exists "student_select_own_attempts" on public.attempts;
create policy "student_select_own_attempts" on public.attempts
  for select to authenticated using (student_id = (select auth.uid()));
drop policy if exists "teacher_select_owned_quiz_attempts" on public.attempts;
create policy "teacher_select_owned_quiz_attempts" on public.attempts
  for select to authenticated using (public.is_teacher() and exists (
    select 1 from public.quizzes q
    where q.id = quiz_id and q.owner_id = (select auth.uid())
  ));

grant select on public.profiles to authenticated;
grant select, insert, update, delete on public.quizzes to authenticated;
grant select, insert, update, delete on public.questions to authenticated;
grant select on public.attempts to authenticated;

create or replace function public.start_quiz_attempt(p_access_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  quiz_row public.quizzes%rowtype;
  attempt_count integer;
  next_attempt integer;
  attempt_row public.attempts%rowtype;
  quiz_questions jsonb;
begin
  if (select auth.uid()) is null then
    raise exception 'Войди в аккаунт, чтобы начать тест.';
  end if;
  if exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.role <> 'student') then
    raise exception 'Аккаунт учителя не может проходить тест как ученик.';
  end if;

  select * into quiz_row
  from public.quizzes
  where access_code = upper(trim(p_access_code)) and is_published = true
  for update;
  if not found then
    raise exception 'Тест не найден или учитель ещё не открыл доступ.';
  end if;

  select count(*) into attempt_count
  from public.attempts
  where quiz_id = quiz_row.id and student_id = (select auth.uid());
  if attempt_count >= 2 then
    raise exception 'Две попытки уже использованы.';
  end if;
  next_attempt := attempt_count + 1;

  select jsonb_agg(
    jsonb_build_object('id', q.id, 'prompt', q.prompt, 'options', q.options)
    order by q.position
  ) into quiz_questions
  from public.questions q where q.quiz_id = quiz_row.id;
  if coalesce(jsonb_array_length(quiz_questions), 0) = 0 then
    raise exception 'В тесте пока нет вопросов.';
  end if;

  insert into public.attempts (quiz_id, student_id, attempt_number, question_count)
  values (quiz_row.id, (select auth.uid()), next_attempt, jsonb_array_length(quiz_questions))
  returning * into attempt_row;

  return jsonb_build_object(
    'attempt_id', attempt_row.id,
    'attempt_number', attempt_row.attempt_number,
    'title', quiz_row.title,
    'duration_minutes', quiz_row.duration_minutes,
    'started_at', attempt_row.started_at,
    'questions', quiz_questions
  );
end;
$$;

create or replace function public.record_focus_violation(p_attempt_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  attempt_row public.attempts%rowtype;
  violation_count integer;
  new_status text;
begin
  select * into attempt_row from public.attempts
  where id = p_attempt_id and student_id = (select auth.uid())
  for update;
  if not found or attempt_row.status <> 'in_progress' then
    raise exception 'Активная попытка не найдена.';
  end if;

  violation_count := least(attempt_row.focus_violations + 1, 2);
  new_status := case when violation_count >= 2 then 'locked' else 'in_progress' end;
  update public.attempts
  set focus_violations = violation_count,
      status = new_status,
      finished_at = case when new_status = 'locked' then now() else null end
  where id = p_attempt_id;

  return jsonb_build_object('violation_count', violation_count, 'status', new_status);
end;
$$;

create or replace function public.submit_quiz_attempt(p_attempt_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  attempt_row public.attempts%rowtype;
  question_row record;
  correct_total integer := 0;
  total integer := 0;
  remaining integer;
begin
  select * into attempt_row from public.attempts
  where id = p_attempt_id and student_id = (select auth.uid())
  for update;
  if not found
     or (attempt_row.status <> 'in_progress'
         and not (attempt_row.status = 'locked' and attempt_row.focus_violations >= 2)) then
    raise exception 'Активная попытка не найдена или уже завершена.';
  end if;

  for question_row in
    select id, correct_index from public.questions where quiz_id = attempt_row.quiz_id
  loop
    total := total + 1;
    if (attempt_row.answers ->> question_row.id::text) ~ '^[0-3]$'
       and (attempt_row.answers ->> question_row.id::text)::integer = question_row.correct_index then
      correct_total := correct_total + 1;
    end if;
  end loop;
  if total = 0 then
    raise exception 'Тест больше не содержит вопросов.';
  end if;

  update public.attempts
  set status = case when attempt_row.status = 'locked' then 'locked' else 'submitted' end,
      correct_count = correct_total,
      question_count = total,
      finished_at = now()
  where id = p_attempt_id;

  select greatest(0, 2 - count(*)) into remaining
  from public.attempts
  where quiz_id = attempt_row.quiz_id and student_id = (select auth.uid());

  return jsonb_build_object(
    'correct_count', correct_total,
    'question_count', total,
    'score_percent', round((correct_total::numeric / total) * 100),
    'attempts_remaining', remaining
  );
end;
$$;

create or replace function public.teacher_quiz_results(p_quiz_id uuid)
returns table (
  student_name text,
  attempt_number smallint,
  status text,
  score_percent integer,
  started_at timestamptz,
  finished_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_teacher() or not exists (
    select 1 from public.quizzes q
    where q.id = p_quiz_id and q.owner_id = (select auth.uid())
  ) then
    raise exception 'Нет доступа к результатам этого теста.';
  end if;

  return query
  select p.display_name,
         a.attempt_number,
         a.status,
         case when a.correct_count is null then null
              else round((a.correct_count::numeric / a.question_count) * 100)::integer end,
         a.started_at,
         a.finished_at
  from public.attempts a
  join public.profiles p on p.id = a.student_id
  where a.quiz_id = p_quiz_id
  order by p.display_name, a.attempt_number;
end;
$$;

revoke all on function public.start_quiz_attempt(text) from public;
revoke all on function public.record_focus_violation(uuid) from public;
revoke all on function public.submit_quiz_attempt(uuid) from public;
revoke all on function public.teacher_quiz_results(uuid) from public;
grant execute on function public.start_quiz_attempt(text) to authenticated;
grant execute on function public.record_focus_violation(uuid) to authenticated;
grant execute on function public.submit_quiz_attempt(uuid) to authenticated;
grant execute on function public.teacher_quiz_results(uuid) to authenticated;
