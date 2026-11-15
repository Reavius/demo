# Тестовый запуск v6 на Render Free

Эта ветка предназначена только для Render. Основной GitHub Pages сайт продолжает работать из `main`.

## Загрузка архива

1. Скачайте ZIP `mechty-venue-site-v6-telegram.zip`.
2. **Не распаковывайте его.**
3. Откройте эту ветку: https://github.com/Reavius/demo/tree/render-v6-deploy
4. Нажмите Add file → Upload files и загрузите ZIP **одним файлом** в корень репозитория. Путь должен быть ровно `mechty-venue-site-v6-telegram.zip`.
5. Нажмите Commit changes, убедившись, что выбрана ветка `render-v6-deploy`.

GitHub Pages не должен публиковать эту ветку. Она используется только Docker-сборкой Render.

## Переменные окружения Render

- `ADMIN_PASSWORD`: придумайте уникальный пароль не короче 14 символов.
- `PERSONAL_DATA_READY`: `false` (оставить выключенным на тесте).
- `TRUST_PROXY`: `1`.
- `DATA_DIR`: `/tmp/mechty-test-data`.
- `UPLOAD_DIR`: `/tmp/mechty-test-data/uploads`.
- `TELEGRAM_BOT_TOKEN`: пока можно не задавать; добавить позже в Environment, не публиковать в GitHub.
- `TELEGRAM_ADMIN_CHAT_IDS`: добавить после создания бота, также только в Environment.

## Ограничения

На бесплатном тарифе нет постоянного диска: тестовые данные и фото могут исчезнуть после перезапуска или деплоя. Не используйте тестовый сервис для реальных броней.
