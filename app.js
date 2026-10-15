(function () {
  const root = document.getElementById("app");
  const accountArea = document.getElementById("account-area");
  const config = window.APP_CONFIG || {};
  const createClient = window.supabase && window.supabase.createClient;
  let client;
  let profile;
  let activeAttempt = null;
  let focusAway = false;
  let focusRequestPending = false;
  let noticeTimer;
  let attemptTimer;

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[char]));
  }

  function showMessage(text, type) {
    const old = document.querySelector(".global-message");
    if (old) old.remove();
    const message = document.createElement("div");
    message.className = `${type || "notice"} global-message`;
    message.setAttribute("role", type === "error" ? "alert" : "status");
    message.textContent = text;
    root.prepend(message);
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => message.remove(), 8000);
  }

  function showError(error) {
    showMessage(error && error.message ? error.message : "Не удалось выполнить действие. Попробуйте ещё раз.", "error");
  }

  function setLoading(message) {
    root.innerHTML = `<div class="loading-card">${escapeHtml(message || "Загружаем…")}</div>`;
  }

  async function getProfile(user) {
    const { data, error } = await client
      .from("profiles")
      .select("id, display_name, role")
      .eq("id", user.id)
      .single();
    if (error) throw error;
    return data;
  }

  function renderAuth() {
    accountArea.textContent = "";
    root.innerHTML = `
      <section class="hero">
        <div class="eyebrow">Учебные тесты без лишней сложности</div>
        <h1>Проверка знаний —<br>спокойно и понятно</h1>
        <p class="lead">Учитель создаёт тест и делится кодом. Ученики проходят его онлайн, а результаты и число попыток сохраняются.</p>
      </section>
      <section class="auth-card">
        <div class="button-row" role="tablist" aria-label="Тип формы">
          <button class="button" id="login-tab" type="button" role="tab" aria-selected="true">Войти</button>
          <button class="button secondary" id="signup-tab" type="button" role="tab" aria-selected="false">Создать аккаунт</button>
        </div>
        <form id="auth-form">
          <div id="name-field" class="field hidden">
            <label for="display-name">Имя и фамилия</label>
            <input id="display-name" name="displayName" maxlength="80" autocomplete="name">
          </div>
          <div class="field">
            <label for="email">Email</label>
            <input id="email" name="email" type="email" maxlength="254" autocomplete="email" required>
          </div>
          <div class="field">
            <label for="password">Пароль</label>
            <input id="password" name="password" type="password" minlength="8" autocomplete="current-password" required>
          </div>
          <div id="auth-message" aria-live="polite"></div>
          <button id="auth-submit" class="button full form-actions" type="submit">Войти</button>
        </form>
        <p class="muted" style="font-size:12px;margin:17px 0 0">Учительские аккаунты назначаются администратором. Новые аккаунты создаются с ролью ученика.</p>
      </section>`;

    let signUp = false;
    const loginTab = document.getElementById("login-tab");
    const signupTab = document.getElementById("signup-tab");
    const nameField = document.getElementById("name-field");
    const submit = document.getElementById("auth-submit");
    const pass = document.getElementById("password");
    function changeMode(next) {
      signUp = next;
      loginTab.className = `button ${signUp ? "secondary" : ""}`;
      signupTab.className = `button ${signUp ? "" : "secondary"}`;
      loginTab.setAttribute("aria-selected", String(!signUp));
      signupTab.setAttribute("aria-selected", String(signUp));
      nameField.classList.toggle("hidden", !signUp);
      document.getElementById("display-name").required = signUp;
      pass.autocomplete = signUp ? "new-password" : "current-password";
      submit.textContent = signUp ? "Создать аккаунт" : "Войти";
      document.getElementById("auth-message").textContent = "";
    }
    loginTab.addEventListener("click", () => changeMode(false));
    signupTab.addEventListener("click", () => changeMode(true));
    document.getElementById("auth-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      submit.disabled = true;
      const email = document.getElementById("email").value.trim();
      const password = pass.value;
      try {
        if (signUp) {
          const displayName = document.getElementById("display-name").value.trim();
          const { data, error } = await client.auth.signUp({
            email,
            password,
            options: { data: { display_name: displayName } }
          });
          if (error) throw error;
          if (!data.session) {
            document.getElementById("auth-message").innerHTML =
              '<div class="success">Аккаунт создан. Подтвердите email по ссылке из письма, затем войдите.</div>';
          } else {
            await refreshSession();
          }
        } else {
          const { error } = await client.auth.signInWithPassword({ email, password });
          if (error) throw error;
          await refreshSession();
        }
      } catch (error) {
        showError(error);
      } finally {
        submit.disabled = false;
      }
    });
  }

  async function refreshSession() {
    const { data, error } = await client.auth.getSession();
    if (error) throw error;
    if (!data.session) {
      profile = null;
      renderAuth();
      return;
    }
    profile = await getProfile(data.session.user);
    if (activeAttempt) renderAttempt();
    else renderHome();
  }

  function renderHeader() {
    const role = profile.role === "teacher" ? "Учитель" : "Ученик";
    accountArea.innerHTML = `
      <span>${escapeHtml(profile.display_name || "Пользователь")}</span>
      <span class="role-badge">${role}</span>
      <button class="text-button" id="logout-button" type="button">Выйти</button>`;
    document.getElementById("logout-button").addEventListener("click", async () => {
      const { error } = await client.auth.signOut();
      if (error) showError(error);
      else {
        activeAttempt = null;
        profile = null;
        renderAuth();
      }
    });
  }

  async function renderHome() {
    if (!profile) return renderAuth();
    renderHeader();
    if (profile.role === "teacher") await renderTeacherHome();
    else await renderStudentHome();
  }

  function studentNotice() {
    return `<div class="notice">При первом уходе со страницы появится предупреждение. При втором текущая попытка завершится и будет учтена в общем лимите из двух попыток. Система не блокирует другие приложения и не может гарантированно определить причину потери фокуса.</div>`;
  }

  async function renderStudentHome(message) {
    let quizzes;
    try {
      const { data, error } = await client.rpc("student_quiz_list");
      if (error) throw error;
      quizzes = data || [];
    } catch (error) {
      root.innerHTML = `<section class="panel"><h2>Кабинет ученика</h2><div class="error">${escapeHtml(error.message)}</div><p class="muted">Обнови базу данных, выполнив supabase/upgrade_student_test_flow.sql в Supabase SQL Editor.</p></section>`;
      return;
    }
    root.innerHTML = `
      <section class="dashboard-head">
        <div><div class="eyebrow">Кабинет ученика</div><h1 style="font-size:34px;margin:7px 0">Тесты</h1>
        <p class="muted">Закрытые тесты можно будет пройти, когда учитель откроет доступ. На каждый тест даётся до двух попыток.</p></div>
      </section>
      <section class="panel">
        ${message ? `<div class="success">${escapeHtml(message)}</div>` : ""}
        <div class="quiz-list">${quizzes.length ? quizzes.map((quiz) => {
          const remaining = Math.max(0, 2 - Number(quiz.attempts_used || 0));
          const available = quiz.is_published && remaining > 0 && quiz.question_count > 0;
          return `<article class="quiz-row">
            <div class="quiz-row-top"><h3>${escapeHtml(quiz.title)}</h3>
              <span class="status-badge ${quiz.is_published ? "" : "status-locked"}">${quiz.is_published ? "Доступ открыт" : "Доступ закрыт"}</span>
            </div>
            <div class="quiz-row-meta">${escapeHtml(quiz.question_count)} вопросов · ${escapeHtml(quiz.duration_minutes)} минут · Осталось попыток: ${remaining}</div>
            <div class="small-actions"><button class="button ${available ? "" : "secondary"} start-listed-quiz" type="button"
              data-code="${escapeHtml(quiz.access_code || "")}" data-duration="${escapeHtml(quiz.duration_minutes)}" ${available ? "" : "disabled"}>
              ${available ? "Начать тест" : quiz.is_published && remaining === 0 ? "Попытки использованы" : "Ожидает учителя"}
            </button></div>
          </article>`;
        }).join("") : '<div class="empty-state">Пока нет тестов. Учитель добавит тесты в этот список.</div>'}</div>
        <div id="join-message"></div>
        ${studentNotice()}
      </section>`;
    root.querySelectorAll(".start-listed-quiz:not(:disabled)").forEach((button) => {
      button.addEventListener("click", () => startQuiz(button.dataset.code, Number(button.dataset.duration), button));
    });
  }

  async function startQuiz(code, durationMinutes, button) {
    button.disabled = true;
    try {
      const { data, error } = await client.rpc("start_quiz_attempt", { p_access_code: code });
      if (error) throw error;
      if (!data || !data.attempt_id || !Array.isArray(data.questions)) {
        throw new Error("Сервер вернул неверный формат теста.");
      }
      activeAttempt = {
        id: data.attempt_id,
        number: data.attempt_number,
        title: data.title,
        questions: data.questions,
        deadline: Date.now() + durationMinutes * 60_000,
        durationMinutes,
        answers: {},
        unsavedAnswers: {},
        violations: 0,
        submitting: false,
        pendingSaves: 0,
        saveQueue: Promise.resolve()
      };
      focusAway = false;
      renderAttempt();
    } catch (error) {
      showError(error);
    } finally {
      button.disabled = false;
    }
  }

  function renderAttempt() {
    if (!activeAttempt) return renderStudentHome();
    clearInterval(attemptTimer);
    renderHeader();
    const test = activeAttempt;
    const progress = Object.keys(test.answers).length;
    root.innerHTML = `
      <section class="panel">
        <div class="attempt-head">
          <div>
            <div class="eyebrow">Попытка ${test.number} из 2</div>
            <h1 style="font-size:28px">${escapeHtml(test.title)}</h1>
          </div>
          <span class="role-badge">${escapeHtml(profile.display_name || "Ученик")}</span>
        </div>
        <div class="attempt-timer" id="attempt-timer" role="timer" aria-live="polite"></div>
        <div class="attempt-progress" aria-label="Прогресс"><span style="width:${test.questions.length ? Math.round(progress / test.questions.length * 100) : 0}%"></span></div>
        ${studentNotice()}
        <form id="attempt-form">
          ${test.questions.map((question, index) => `
            <fieldset class="question-card" style="border-style:solid">
              <legend class="hidden">Вопрос ${index + 1}</legend>
              <h3>${index + 1}. ${escapeHtml(question.prompt)}</h3>
              ${(question.options || []).map((option, optionIndex) => `
                <label class="option">
                  <input type="radio" name="q-${escapeHtml(question.id)}" value="${optionIndex}" ${String(test.answers[question.id]) === String(optionIndex) ? "checked" : ""}>
                  <span>${escapeHtml(option)}</span>
                </label>`).join("")}
            </fieldset>`).join("")}
          <div class="button-row" style="justify-content:space-between;margin-top:20px">
            <span class="muted">${progress} из ${test.questions.length} ответов</span>
            <button id="submit-attempt" class="button" type="submit" ${test.pendingSaves ? "disabled" : ""}>${test.submitting ? "Отправка…" : "Завершить тест"}</button>
          </div>
        </form>
      </section>`;

    const updateTimer = () => {
      if (!activeAttempt || activeAttempt !== test) return clearInterval(attemptTimer);
      const remaining = Math.max(0, test.deadline - Date.now());
      const seconds = Math.ceil(remaining / 1000);
      const timer = document.getElementById("attempt-timer");
      if (timer) {
        timer.textContent = `Осталось времени: ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
        timer.classList.toggle("timer-warning", seconds <= 60);
      }
      if (remaining <= 0) {
        clearInterval(attemptTimer);
        submitAttempt(null, false, true);
      }
    };
    updateTimer();
    attemptTimer = setInterval(updateTimer, 1000);

    root.querySelectorAll('#attempt-form input[type="radio"]').forEach((radio) => {
      radio.addEventListener("change", (event) => {
        const questionId = event.target.name.slice(2);
        const answer = Number(event.target.value);
        test.answers[questionId] = answer;
        test.unsavedAnswers[questionId] = answer;
        const progressText = root.querySelector(".button-row .muted");
        progressText.textContent = `${Object.keys(test.answers).length} из ${test.questions.length} ответов`;
        root.querySelector(".attempt-progress span").style.width =
          `${Math.round(Object.keys(test.answers).length / test.questions.length * 100)}%`;
        test.pendingSaves += 1;
        document.getElementById("submit-attempt").disabled = true;
        test.saveQueue = test.saveQueue.catch(() => {}).then(async () => {
          const { error } = await client.rpc("save_quiz_answer", {
            p_attempt_id: test.id,
            p_question_id: questionId,
            p_answer: answer
          });
          if (error) throw error;
          if (test.answers[questionId] === answer) delete test.unsavedAnswers[questionId];
        }).catch((error) => {
          showError(error);
        }).finally(() => {
          test.pendingSaves -= 1;
          const submitButton = document.getElementById("submit-attempt");
          if (submitButton && activeAttempt === test) submitButton.disabled = test.pendingSaves > 0;
        });
      });
    });
    document.getElementById("attempt-form").addEventListener("submit", submitAttempt);
  }

  async function submitAttempt(event, lockedByViolation, timedOut) {
    if (event) event.preventDefault();
    if (!activeAttempt || activeAttempt.submitting) return;
    const test = activeAttempt;
    if (test.pendingSaves) await test.saveQueue;
    if (activeAttempt !== test || test.submitting) return;
    if (Object.keys(test.unsavedAnswers).length && !timedOut) {
      showError(new Error("Не удалось сохранить выбранный ответ. Выберите ответ ещё раз и дождитесь сохранения."));
      return;
    }
    if (!lockedByViolation) {
      const unanswered = test.questions.length - Object.keys(test.answers).length;
      if (unanswered > 0 && !timedOut && !window.confirm(`Осталось вопросов без ответа: ${unanswered}. Завершить тест?`)) return;
    }
    test.submitting = true;
    clearInterval(attemptTimer);
    const button = document.getElementById("submit-attempt");
    if (button) button.disabled = true;
    try {
      const { data, error } = await client.rpc("submit_quiz_attempt", {
        p_attempt_id: activeAttempt.id
      });
      if (error) throw error;
      renderResult(data, lockedByViolation, timedOut);
      activeAttempt = null;
    } catch (error) {
      if (activeAttempt) activeAttempt.submitting = false;
      showError(error);
      if (activeAttempt) renderAttempt();
    }
  }

  function renderResult(result, lockedByViolation, timedOut) {
    renderHeader();
    const percent = result && Number.isFinite(Number(result.score_percent)) ? Number(result.score_percent) : null;
    root.innerHTML = `
      <section class="result-card">
        <div class="eyebrow">${lockedByViolation ? "Попытка завершена" : timedOut ? "Время закончилось" : "Ответы сохранены"}</div>
        <h1 style="font-size:32px">${lockedByViolation ? "Попытка закрыта" : timedOut ? "Время вышло" : "Тест завершён"}</h1>
        ${percent === null ? "" : `<div class="result-score">${percent}%</div>`}
        <p class="lead">${lockedByViolation
          ? "Вы дважды покинули страницу теста. Эта попытка завершена и учтена."
          : `Правильных ответов: ${escapeHtml(result.correct_count)} из ${escapeHtml(result.question_count)}.${timedOut ? " Время на тест закончилось." : ""}`}</p>
        <p class="muted">${result && Number.isInteger(result.attempts_remaining) ? `Осталось попыток: ${result.attempts_remaining}.` : ""}</p>
        <button id="back-home" class="button secondary" type="button">В кабинет</button>
      </section>`;
    document.getElementById("back-home").addEventListener("click", () => renderStudentHome());
  }

  async function monitorFocus() {
    if (!activeAttempt || focusRequestPending) return;
    focusRequestPending = true;
    try {
      const { data, error } = await client.rpc("record_focus_violation", { p_attempt_id: activeAttempt.id });
      if (error) throw error;
      if (!data || !activeAttempt) return;
      activeAttempt.violations = data.violation_count;
      if (data.status === "locked") {
        await submitAttempt(null, true);
      } else {
        showMessage("Внимание: вы покинули страницу теста. При повторном уходе эта попытка завершится.", "error");
      }
    } catch (error) {
      showError(new Error(`Не удалось записать событие ухода со страницы: ${error.message}`));
    } finally {
      focusRequestPending = false;
    }
  }

  function onVisibilityChange() {
    if (!activeAttempt) {
      focusAway = document.hidden;
      return;
    }
    if (document.hidden && !focusAway) {
      focusAway = true;
      monitorFocus();
    } else if (!document.hidden) {
      focusAway = false;
    }
  }

  function randomCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const values = new Uint8Array(6);
    crypto.getRandomValues(values);
    return Array.from(values, (value) => chars[value % chars.length]).join("");
  }

  const itSampleQuestions = [
    ["Что означает аббревиатура IT?", ["Информационные технологии", "Интернет-телефония", "Интерактивный текст", "Индекс таблицы"], 0],
    ["Какое устройство используется для ввода текста?", ["Монитор", "Клавиатура", "Колонки", "Проектор"], 1],
    ["Как называется основное устройство для вычислений в компьютере?", ["Процессор", "Принтер", "Микрофон", "Сканер"], 0],
    ["Для чего нужна операционная система?", ["Для управления компьютером и программами", "Только для печати", "Для зарядки батареи", "Для очистки экрана"], 0],
    ["Какая программа обычно открывает веб-страницы?", ["Браузер", "Калькулятор", "Архиватор", "Драйвер"], 0],
    ["Что такое файл?", ["Именованный набор данных", "Часть клавиатуры", "Тип кабеля", "Команда выключения"], 0],
    ["Какое расширение часто используют для изображений?", [".mp3", ".png", ".exe", ".docx"], 1],
    ["Какой пароль надёжнее?", ["12345678", "password", "R7!mQ2#vL9", "qwerty"], 2],
    ["Что помогает защитить аккаунт помимо пароля?", ["Двухфакторная аутентификация", "Одинаковый пароль везде", "Публикация пароля", "Отключение обновлений"], 0],
    ["Что такое облачное хранилище?", ["Хранение файлов на удалённых серверах", "Папка только на рабочем столе", "Вид монитора", "Кабель для интернета"], 0],
    ["Что из перечисленного является поисковой системой?", ["Google", "Windows", "Bluetooth", "USB"], 0],
    ["Для чего применяется электронная таблица?", ["Для работы с данными и расчётами", "Для записи звука", "Для настройки яркости", "Для подключения мыши"], 0],
    ["Что такое алгоритм?", ["Последовательность шагов для решения задачи", "Название монитора", "Тип пароля", "Формат фотографии"], 0],
    ["Как называется ошибка в программе?", ["Баг", "Пиксель", "Папка", "Ссылка"], 0],
    ["Какое значение обычно означает логическое «истина»?", ["true", "maybe", "file", "null"], 0],
    ["Что делает команда копирования?", ["Создаёт дубликат выбранных данных", "Удаляет данные", "Выключает компьютер", "Меняет язык"], 0],
    ["Какой знак часто начинают использовать для комментария в JavaScript?", ["//", "%%", "&&&", "???"], 0],
    ["Что такое URL?", ["Адрес ресурса в интернете", "Модель процессора", "Формат батареи", "Имя пользователя Windows"], 0],
    ["Какое устройство раздаёт интернет по Wi-Fi?", ["Маршрутизатор", "Сканер", "Веб-камера", "Флешка"], 0],
    ["Что такое резервная копия?", ["Дополнительная копия данных на случай потери", "Временная ошибка", "Новый пароль", "Список открытых вкладок"], 0],
    ["Как следует поступить с подозрительной ссылкой из письма?", ["Не открывать и проверить отправителя", "Сразу ввести пароль", "Переслать всем контактам", "Отключить антивирус"], 0],
    ["Для чего нужен антивирус?", ["Для обнаружения и блокировки вредоносных программ", "Для создания презентаций", "Для ускорения печати", "Для рисования схем"], 0],
    ["Что обозначает HTML в веб-разработке?", ["Язык разметки веб-страниц", "Операционная система", "Антивирусный протокол", "Тип базы данных"], 0],
    ["Какой символ обычно ставят в конце команды в JavaScript?", [";", "#", "@", "~"], 0],
    ["Что такое база данных?", ["Организованное хранилище данных", "Устройство для вывода звука", "Вид браузера", "Сетевой кабель"], 0]
  ];

  function fillItSample() {
    document.getElementById("quiz-title").value = "Информатика — основы IT (25 вопросов)";
    const editors = document.getElementById("question-editors");
    editors.innerHTML = itSampleQuestions.map(([prompt, options, correct_index], index) =>
      makeQuestionEditor(index, { prompt, options, correct_index })
    ).join("");
    updateQuestionCount();
    bindRemoveQuestionButtons();
  }

  function updateQuestionCount() {
    const count = document.getElementById("question-count");
    const editors = document.getElementById("question-editors");
    if (count && editors) count.textContent = `Вопросов: ${editors.querySelectorAll("[data-question]").length}`;
  }

  function makeQuestionEditor(index, question) {
    const q = question || { prompt: "", options: ["", "", "", ""], correct_index: 0 };
    return `
      <div class="question-editor" data-question>
        <div class="question-title-row">
          <h3>Вопрос ${index + 1}</h3>
          <button type="button" class="text-button remove-question">Удалить</button>
        </div>
        <div class="field">
          <label>Текст вопроса</label>
          <input data-prompt maxlength="500" value="${escapeHtml(q.prompt)}" placeholder="Напишите вопрос" required>
        </div>
        <div class="answer-list">
          ${(q.options || ["", "", "", ""]).map((option, optionIndex) => `
            <label class="field">
              <span class="answer-choice"><input type="radio" name="correct-${index}" value="${optionIndex}" ${Number(q.correct_index) === optionIndex ? "checked" : ""}> Правильный ответ</span>
              <input data-option="${optionIndex}" maxlength="250" value="${escapeHtml(option)}" placeholder="Вариант ${optionIndex + 1}" required>
            </label>`).join("")}
        </div>
      </div>`;
  }

  function collectQuestions() {
    const editors = Array.from(document.querySelectorAll("[data-question]"));
    return editors.map((editor, index) => {
      const correct = editor.querySelector(`input[name="correct-${index}"]:checked`);
      return {
        position: index + 1,
        prompt: editor.querySelector("[data-prompt]").value.trim(),
        options: Array.from(editor.querySelectorAll("[data-option]")).map((input) => input.value.trim()),
        correct_index: correct ? Number(correct.value) : -1
      };
    });
  }

  function validateQuestions(questions) {
    if (!questions.length) throw new Error("Добавьте хотя бы один вопрос.");
    for (const [index, question] of questions.entries()) {
      if (!question.prompt) throw new Error(`Заполните текст вопроса ${index + 1}.`);
      if (question.options.some((option) => !option)) throw new Error(`Заполните все варианты ответа у вопроса ${index + 1}.`);
      if (question.correct_index < 0) throw new Error(`Отметьте правильный вариант у вопроса ${index + 1}.`);
    }
  }

  async function renderTeacherHome() {
    const { data, error } = await client.from("quizzes")
      .select("id, title, access_code, is_published, created_at, duration_minutes, questions(count)")
      .order("created_at", { ascending: false });
    if (error) {
      root.innerHTML = `<section class="panel"><h2>Кабинет учителя</h2><div class="error">${escapeHtml(error.message)}</div><p class="muted">Проверь, что SQL-схема из папки supabase/schema.sql установлена.</p></section>`;
      return;
    }
    root.innerHTML = `
      <div class="dashboard-head">
        <div><div class="eyebrow">Кабинет учителя</div><h1 style="font-size:34px;margin:7px 0">Мои тесты</h1><p class="muted">Создавай тесты, открывай доступ и смотри результаты.</p></div>
        <div class="button-row"><button id="new-quiz" type="button" class="button">＋ Новый тест</button></div>
      </div>
      <div class="dashboard-grid">
        <section class="panel">
          <h2>Список тестов</h2>
          <div id="quiz-list" class="quiz-list"></div>
        </section>
        <section id="quiz-editor-panel" class="panel">
          <h2>Создать тест</h2>
          <p class="muted">Укажи тему и время, добавь нужное количество вопросов. Правильный ответ ученику не показывается.</p>
          <form id="quiz-form">
            <div class="field"><label for="quiz-title">Название теста</label><input id="quiz-title" maxlength="120" required placeholder="Например, История Казахстана — тема 3"></div>
            <div class="field"><label for="quiz-duration">Время на тест (минуты)</label><input id="quiz-duration" type="number" min="1" max="300" value="30" required></div>
            <div class="button-row"><span id="question-count" class="muted">Вопросов: 1</span><button id="fill-it-sample" class="button secondary" type="button">Заполнить пример IT — 25 вопросов</button></div>
            <div id="question-editors">${makeQuestionEditor(0)}</div>
            <div class="button-row"><button id="add-question" class="button ghost" type="button">＋ Добавить вопрос</button><button class="button" type="submit">Сохранить черновик</button></div>
            <div id="quiz-form-message"></div>
          </form>
        </section>
      </div>`;

    const list = document.getElementById("quiz-list");
    if (!data.length) list.innerHTML = '<div class="empty-state">Пока нет тестов. Создай первый в панели справа.</div>';
    else {
      list.innerHTML = data.map((quiz) => `
        <article class="quiz-row" data-quiz="${escapeHtml(quiz.id)}">
          <div class="quiz-row-top"><h3>${escapeHtml(quiz.title)}</h3><span class="status-badge">${quiz.is_published ? "Открыт" : "Черновик"}</span></div>
          <span class="quiz-code">${escapeHtml(quiz.access_code)}</span>
          <div class="quiz-row-meta">${escapeHtml(quiz.questions && quiz.questions[0] ? quiz.questions[0].count : 0)} вопросов · ${escapeHtml(quiz.duration_minutes)} минут</div>
          <div class="quiz-row-meta">Код для учеников · ${quiz.is_published ? "принимает попытки" : "доступ закрыт"}</div>
          <div class="small-actions">
            <button class="button secondary toggle-publish" type="button" data-id="${escapeHtml(quiz.id)}" data-published="${quiz.is_published}">${quiz.is_published ? "Закрыть доступ" : "Открыть доступ"}</button>
            <button class="button ghost copy-code" type="button" data-code="${escapeHtml(quiz.access_code)}">Скопировать код</button>
            <button class="button ghost view-results" type="button" data-id="${escapeHtml(quiz.id)}">Результаты</button>
          </div>
          <div class="results-slot" id="results-${escapeHtml(quiz.id)}"></div>
        </article>`).join("");
    }
    document.getElementById("new-quiz").addEventListener("click", () => {
      document.getElementById("quiz-title").focus();
      document.getElementById("quiz-editor-panel").scrollIntoView({ behavior: "smooth", block: "center" });
    });
    document.getElementById("add-question").addEventListener("click", () => {
      const editors = document.getElementById("question-editors");
      const index = editors.querySelectorAll("[data-question]").length;
      editors.insertAdjacentHTML("beforeend", makeQuestionEditor(index));
      bindRemoveQuestionButtons();
      updateQuestionCount();
    });
    document.getElementById("fill-it-sample").addEventListener("click", fillItSample);
    updateQuestionCount();
    bindRemoveQuestionButtons();
    document.getElementById("quiz-form").addEventListener("submit", createQuiz);
    list.querySelectorAll(".toggle-publish").forEach((button) => button.addEventListener("click", togglePublish));
    list.querySelectorAll(".copy-code").forEach((button) => button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(button.dataset.code);
        showMessage("Код теста скопирован.", "success");
      } catch {
        showMessage(`Код теста: ${button.dataset.code}`, "notice");
      }
    }));
    list.querySelectorAll(".view-results").forEach((button) => button.addEventListener("click", showResults));
  }

  function bindRemoveQuestionButtons() {
    document.querySelectorAll(".remove-question").forEach((button) => {
      button.onclick = () => {
        const editors = document.getElementById("question-editors");
        if (editors.querySelectorAll("[data-question]").length <= 1) {
          showError(new Error("В тесте должен остаться хотя бы один вопрос."));
          return;
        }
        button.closest("[data-question]").remove();
        Array.from(editors.querySelectorAll("[data-question]")).forEach((editor, index) => {
          editor.querySelector("h3").textContent = `Вопрос ${index + 1}`;
          editor.querySelectorAll('input[type="radio"]').forEach((radio) => { radio.name = `correct-${index}`; });
        });
        updateQuestionCount();
      };
    });
  }

  async function createQuiz(event) {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const questions = collectQuestions();
      validateQuestions(questions);
      const title = document.getElementById("quiz-title").value.trim();
      const { data: quiz, error } = await client.from("quizzes").insert({
        owner_id: profile.id,
        title,
        duration_minutes: Number(document.getElementById("quiz-duration").value),
        access_code: randomCode(),
        is_published: false
      }).select("id").single();
      if (error) throw error;
      const rows = questions.map((question) => ({ ...question, quiz_id: quiz.id }));
      const { error: questionsError } = await client.from("questions").insert(rows);
      if (questionsError) {
        const { error: deleteError } = await client.from("quizzes").delete().eq("id", quiz.id);
        if (deleteError) throw new Error(`Вопросы не сохранились (${questionsError.message}); удалить пустой черновик не удалось (${deleteError.message}).`);
        throw questionsError;
      }
      showMessage("Черновик теста сохранён. Открой доступ, когда будешь готов.", "success");
      await renderTeacherHome();
    } catch (error) {
      showError(error);
    } finally {
      button.disabled = false;
    }
  }

  async function togglePublish(event) {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const { error } = await client.from("quizzes")
        .update({ is_published: button.dataset.published !== "true" })
        .eq("id", button.dataset.id);
      if (error) throw error;
      await renderTeacherHome();
      showMessage(button.dataset.published === "true" ? "Доступ к тесту закрыт." : "Тест открыт. Поделись кодом с учениками.", "success");
    } catch (error) {
      showError(error);
      button.disabled = false;
    }
  }

  async function showResults(event) {
    const id = event.currentTarget.dataset.id;
    const slot = document.getElementById(`results-${id}`);
    slot.innerHTML = '<p class="muted">Загрузка результатов…</p>';
    try {
      const { data, error } = await client.rpc("teacher_quiz_results", { p_quiz_id: id });
      if (error) throw error;
      if (!data.length) {
        slot.innerHTML = '<div class="empty-state">Пока никто не проходил этот тест.</div>';
        return;
      }
      slot.innerHTML = `<div style="overflow-x:auto;margin-top:12px"><table class="results-table">
        <thead><tr><th>Ученик</th><th>Попытка</th><th>Результат</th><th>Статус</th></tr></thead>
        <tbody>${data.map((row) => `<tr>
          <td>${escapeHtml(row.student_name)}</td>
          <td>${escapeHtml(row.attempt_number)} / 2</td>
          <td>${row.score_percent == null ? "—" : `${escapeHtml(row.score_percent)}%`}</td>
          <td>${row.status === "locked" ? "Завершена после предупреждений" : row.status === "submitted" ? "Сдана" : "В процессе"}</td>
        </tr>`).join("")}</tbody>
      </table></div>`;
    } catch (error) {
      slot.innerHTML = "";
      showError(error);
    }
  }

  async function initialize() {
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("blur", () => {
      if (activeAttempt && !document.hidden && !focusAway) {
        focusAway = true;
        monitorFocus();
      }
    });
    window.addEventListener("focus", () => {
      if (!document.hidden) focusAway = false;
    });

    if (!createClient || !config.supabaseUrl || !config.supabaseAnonKey) {
      root.innerHTML = `
        <section class="hero"><div class="eyebrow">Первый запуск</div><h1>Подключи базу данных</h1>
          <p class="lead">Добавь URL проекта Supabase и публичный anon key в <code>config.js</code>, затем выполни <code>supabase/schema.sql</code> в SQL Editor проекта.</p>
        </section>
        <section class="auth-card">
          <h2>Что будет работать</h2>
          <p class="muted">Email-аккаунты, роли учителя и ученика, коды тестов, до двух попыток, оценивание и предупреждения при уходе со страницы. Ответы и правильные варианты хранятся с проверкой прав на сервере.</p>
          <div class="notice">Не публикуй пароли и service role key. В браузер можно добавлять только anon key; доступ ограничивают политики базы данных.</div>
        </section>`;
      return;
    }
    client = createClient(config.supabaseUrl, config.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
    try {
      await refreshSession();
    } catch (error) {
      showError(error);
      renderAuth();
    }
    client.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") {
        profile = null;
        activeAttempt = null;
        renderAuth();
      } else if (event === "SIGNED_IN" && !profile) {
        setTimeout(() => refreshSession().catch(showError), 0);
      }
    });
  }

  initialize();
}());
