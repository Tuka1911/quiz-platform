create table if not exists public.quiz_attempt_grants (
  quiz_id uuid not null references public.quizzes (id) on delete cascade,
  student_id uuid not null references public.profiles (id) on delete cascade,
  extra_attempts smallint not null default 0 check (extra_attempts between 0 and 100),
  updated_at timestamptz not null default now(),
  primary key (quiz_id, student_id)
);

alter table public.quiz_attempt_grants enable row level security;
revoke all on public.quiz_attempt_grants from anon, public, authenticated;

alter table public.attempts drop constraint if exists attempts_attempt_number_check;
alter table public.attempts add constraint attempts_attempt_number_check check (attempt_number > 0);
alter table public.attempts drop constraint if exists attempts_quiz_id_student_id_attempt_number_key;
alter table public.attempts add constraint attempts_quiz_id_student_id_attempt_number_key
  unique (quiz_id, student_id, attempt_number);

drop function if exists public.student_quiz_list();
create function public.student_quiz_list()
returns table (
  quiz_id uuid,
  title text,
  is_published boolean,
  question_count bigint,
  duration_minutes integer,
  attempts_used bigint,
  attempts_allowed bigint,
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
         2::bigint + coalesce((select g.extra_attempts::bigint from public.quiz_attempt_grants g
                               where g.quiz_id = q.id and g.student_id = (select auth.uid())), 0::bigint),
         case when q.is_published then q.access_code else null end
  from public.quizzes q
  order by q.created_at desc;
end;
$$;
revoke all on function public.student_quiz_list() from public;
grant execute on function public.student_quiz_list() to authenticated;

drop function if exists public.start_quiz_attempt(text);
create function public.start_quiz_attempt(p_access_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  quiz_row public.quizzes%rowtype;
  attempt_count integer;
  attempt_limit integer;
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
  select 2 + coalesce(g.extra_attempts, 0) into attempt_limit
  from (select 1) one
  left join public.quiz_attempt_grants g
    on g.quiz_id = quiz_row.id and g.student_id = (select auth.uid());
  if attempt_count >= attempt_limit then
    raise exception 'Ученик использовал все разрешённые попытки.';
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
    'attempts_allowed', attempt_limit,
    'title', quiz_row.title,
    'duration_minutes', quiz_row.duration_minutes,
    'started_at', attempt_row.started_at,
    'questions', quiz_questions
  );
end;
$$;
revoke all on function public.start_quiz_attempt(text) from public;
grant execute on function public.start_quiz_attempt(text) to authenticated;

drop function if exists public.submit_quiz_attempt(uuid);
create function public.submit_quiz_attempt(p_attempt_id uuid)
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

  select greatest(0, 2 + coalesce(g.extra_attempts, 0) - count(*)) into remaining
  from public.attempts a
  left join public.quiz_attempt_grants g
    on g.quiz_id = attempt_row.quiz_id and g.student_id = (select auth.uid())
  where a.quiz_id = attempt_row.quiz_id and a.student_id = (select auth.uid())
  group by g.extra_attempts;

  return jsonb_build_object(
    'correct_count', correct_total,
    'question_count', total,
    'score_percent', round((correct_total::numeric / total) * 100),
    'attempts_remaining', remaining
  );
end;
$$;
revoke all on function public.submit_quiz_attempt(uuid) from public;
grant execute on function public.submit_quiz_attempt(uuid) to authenticated;

drop function if exists public.teacher_quiz_results(uuid);
create function public.teacher_quiz_results(p_quiz_id uuid)
returns table (
  student_id uuid,
  student_name text,
  attempt_number smallint,
  attempts_allowed integer,
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
  select p.id,
         p.display_name,
         a.attempt_number,
         2 + coalesce((select g.extra_attempts from public.quiz_attempt_grants g
                       where g.quiz_id = a.quiz_id and g.student_id = a.student_id), 0),
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
revoke all on function public.teacher_quiz_results(uuid) from public;
grant execute on function public.teacher_quiz_results(uuid) to authenticated;

create or replace function public.teacher_grant_quiz_attempt(p_quiz_id uuid, p_student_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  granted integer;
begin
  if not public.is_teacher() or not exists (
    select 1 from public.quizzes q
    where q.id = p_quiz_id and q.owner_id = (select auth.uid())
  ) then
    raise exception 'Нет доступа к этому тесту.';
  end if;
  perform 1 from public.quizzes q where q.id = p_quiz_id for update;
  if not exists (select 1 from public.profiles p where p.id = p_student_id and p.role = 'student')
     or not exists (select 1 from public.attempts a where a.quiz_id = p_quiz_id and a.student_id = p_student_id) then
    raise exception 'Ученик не найден среди участников этого теста.';
  end if;

  insert into public.quiz_attempt_grants (quiz_id, student_id, extra_attempts)
  values (p_quiz_id, p_student_id, 1)
  on conflict (quiz_id, student_id) do update
    set extra_attempts = public.quiz_attempt_grants.extra_attempts + 1,
        updated_at = now()
  returning extra_attempts into granted;

  return 2 + granted;
end;
$$;
revoke all on function public.teacher_grant_quiz_attempt(uuid, uuid) from public;
grant execute on function public.teacher_grant_quiz_attempt(uuid, uuid) to authenticated;
