# Claude × Codex Router UI

Локальна панель для повного налаштування та керування глобальною політикою маршрутизації Claude Code → Codex.

Модель, effort і thinking самого Claude вибираються у поточному вікні Claude та не перевизначаються цією панеллю. Панель керує тригерами делегування, перевіркою плану та моделлю/effort для викликів Codex.

Вкладка **Task & token history** читає локальні журнали `~/.claude/projects` і `~/.codex/sessions`. Показані числа — технічні token counters клієнтів, а не білінг або точний відсоток корпоративного subscription-ліміту. У цій самій вкладці можна встановити локальний логер рішень `Claude-only / delegated / audit`.

## Встановлення через npm

Пакет публікується як macOS developer tool без `postinstall` side effects. Встановлення з npm саме по собі не змінює `~/.claude`, не додає LaunchAgent і не ставить Claude/Codex plugin. Локальні зміни виконуються лише після явної команди.

Разовий запуск:

```bash
npx claude-codex-router start
```

Встановлення фонової локальної панелі:

```bash
npm i -g claude-codex-router
claude-codex-router install
```

Корисні команди:

```bash
claude-codex-router start          # foreground server на http://127.0.0.1:4177
claude-codex-router install        # install/repair macOS LaunchAgent і відкрити UI
claude-codex-router uninstall      # прибрати лише background service
claude-codex-router open           # відкрити UI
claude-codex-router doctor         # локальний статус Claude/Codex/plugin/routing
claude-codex-router build-portable # зібрати ZIP installer для іншого Mac
```

## Встановлення як desktop PWA на macOS

1. Двічі відкрийте `Install Desktop PWA.command`.
2. Якщо Node.js 18+ відсутній, bootstrapper завантажить pinned Node.js `v22.13.1` з `nodejs.org`, перевірить SHA-256 і збереже runtime у `~/Library/Application Support/ClaudeCodexRouter/runtime`. `sudo` і зміни системного Node не потрібні.
3. Скрипт встановить маленький локальний background service і відкриє панель у Chrome.
4. Відкрийте **Setup from zero** і пройдіть шість пояснених перевірок.
5. Після готовності натисніть **Install app** та підтвердьте встановлення браузером.

Після цього **AI Router** з’явиться в Launchpad/Dock і запускатиметься як окреме вікно. Background service стартує разом із входом у macOS, тому ярлик завжди матиме доступ до локального конфігуратора.

Інсталятор не потребує прав адміністратора. Він створює user LaunchAgent, а за відсутності Node — приватний runtime Router:

```text
~/Library/LaunchAgents/com.local.claude-codex-router-ui.plist
```

Щоб прибрати фоновий сервіс, відкрийте `Uninstall Background Service.command`. Routing-конфіг і backups при цьому залишаються.

Якщо папку застосунку переміщено, повторно запустіть інсталятор, щоб оновити шлях у LaunchAgent.

## Setup from zero

Майстер у вкладці **Setup from zero** виконує налаштування послідовно:

1. Перевіряє Node.js, npm і Git.
2. Виявляє Claude Desktop/CLI та відкриває `claude auth login --sso` у видимому Terminal-вікні. Корпоративний SSO проходить безпосередньо в Claude; Router не читає credentials.
3. Виявляє або встановлює `@openai/codex` у `~/.claude-codex-router/tools`, після чого відкриває звичайний `codex login` для ChatGPT subscription OAuth.
4. Через офіційний Claude CLI додає `openai/codex-plugin-cc` та встановлює `codex@openai-codex` у user scope.
5. Застосовує routing policy і decision logger з backups.
6. Запускає безтокеновий self-check plugin runtime → Codex auth. Опційний **Live handshake** робить один короткий Codex turn, не читає і не змінює файли.

Setup-процеси видаляють `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` і custom base URL лише зі свого дочірнього environment. Якщо такі overrides записані в Claude settings, UI покаже попередження, але не видалятиме налаштування мовчки.

Якщо corporate policy має `strictKnownMarketplaces` або `allowManagedHooksOnly`, майстер покаже конкретний заблокований шар. Managed policy не обходиться: адміністратор має дозволити `openai/codex-plugin-cc` та/або user hooks.

## Встановлення на іншому Mac

Натисніть **Export installer** у верхній панелі або відкрийте `Build Portable Installer.command`. Буде створено:

```text
public/downloads/Claude-Codex-Router-UI.zip
```

Передайте ZIP на інший Mac, розпакуйте його та відкрийте `Install Desktop PWA.command`. Інсталятор сам визначає Homebrew, NVM або mise Node.js, а за їх відсутності ставить приватний pinned runtime. Він не залежить від шляхів першого комп’ютера.

Вимоги до іншого Mac:

- macOS;
- доступ до корпоративного Claude workspace та ChatGPT/Codex subscription;
- мережевий доступ до `claude.ai`, `nodejs.org`, GitHub marketplace і ChatGPT OAuth під час першого setup.

Credentials, routing-конфіг і backups у ZIP не потрапляють.

## Лог рішень роутера

Кнопка **Install logger** у вкладці історії:

- копіює локальний logger у `~/.claude/router-hooks/route-logger.mjs`;
- безпечно додає свої записи в `~/.claude/settings.json`, не видаляючи інші hooks або корпоративні налаштування;
- пише лише routing metadata у `~/.claude/router-history/events.jsonl` — тип рішення, модель Codex, effort, verdict, session id, час і робочу папку;
- не записує промпти, відповіді, вміст файлів чи код.

**Repair** відновлює лише hooks цієї утиліти. **Uninstall** прибирає logger і його записи з Claude settings, але залишає локальну історію. Перед кожною зміною `settings.json` створюється backup у `~/.claude/router-hooks/backups/`.

Якщо корпоративна політика Claude має `allowManagedHooksOnly: true`, UI покаже обмеження. У такому випадку user hook не запрацює без дозволу адміністратора, навіть якщо файли інсталятора записані локально.

## Звичайний запуск без встановлення

Двічі натисніть `start.command` або виконайте:

```bash
./start.command
```

Панель відкриється на `http://127.0.0.1:4177`. Сервер слухає лише localhost і не використовує API-ключі.

## Що змінюється

Після натискання **Apply routing policy** UI записує:

```text
~/.claude/rules/agent-routing.md
```

Перед кожним перезаписом попередня версія зберігається в:

```text
~/.claude/rules/.routing-ui-backups/
```

Перший Save переведе файл під керування UI. Якщо файл уже існує, він спершу буде скопійований у backup. Кнопка **Restore last backup** повертає останню версію.

Відкрийте нову Local Code-сесію Claude Desktop після застосування змін.

## Перевірка

```bash
npm test
npm run pack:check
```

Залежності не потрібні: застосунок використовує лише стандартні модулі Node.js.

## Публікація в npm

Поточний package підготовлений для npm як `claude-codex-router`. Перед першим publish перевірте `NPM_PUBLISH_CHECKLIST.md`, залогіньтесь у npm і запустіть:

```bash
npm test
npm run pack:check
npm publish
```

Якщо перед публікацією назву буде змінено на scoped package, наприклад `@alex-moroz/claude-codex-router`, використовуйте:

```bash
npm publish --access public
```
