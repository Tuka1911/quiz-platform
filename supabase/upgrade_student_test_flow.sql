-- Run once in Supabase SQL Editor to upgrade an existing TestKlass database.
alter table public.quizzes
  add column if not exists duration_minutes integer not null default 30;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.quizzes'::regclass
      and conname = 'quizzes_duration_minutes_check'
  ) then
    alter table public.quizzes
      add constraint quizzes_duration_minutes_check
      check (duration_minutes between 1 and 300);
  end if;
end;
$$;

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

drop function if exists public.submit_quiz_attempt(uuid, jsonb);

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

revoke all on function public.submit_quiz_attempt(uuid) from public;
grant execute on function public.submit_quiz_attempt(uuid) to authenticated;
