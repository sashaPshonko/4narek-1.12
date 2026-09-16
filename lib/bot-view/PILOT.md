# Bot-view pilot + motion record

Запись реальной мыши/WASD с TLauncher через бота на FunTime.

## Локально (ванильный стек `4NAREK.mjs`)

```bash
cd ~/4narek-1.12   # или локальный путь

VIEW_PILOT=1 VIEW_RECORD=1 VIEW_PORT=25501 \
  node scripts/run-4narek-local.mjs \
    --user NICK --pass PASS --an 502 \
    --proxy 'socks5://u:p@host:port' \
    --ip local
```

В логе: `view: PILOT mode port=25501` и `TLauncher → 0.0.0.0:25501`.

В TLauncher / vanilla 1.21.11: сервер `127.0.0.1:25501` (offline).

1. Дождись входа бота на анку.
2. Зайди зрителем — pilot уже ON; при `VIEW_RECORD=1` запись стартует сразу.
3. Ходи **W + мышь** как обычно.
4. В чате зрителя: `!rec stop` — файл в `motion-records/*.jsonl`.
5. Или без автозаписи: `!rec start walk1` → походил → `!rec stop`.

## Команды в чате зрителя (`!…` на FunTime не уходят)

| Команда | Действие |
|---|---|
| `!pilot on` / `!pilot off` | вкл/выкл прокидку look+input |
| `!rec start [tag]` | начать JSONL |
| `!rec stop` | остановить, путь в лог |
| `!rec status` | счётчик сэмплов |
| `!help` | кратко в лог воркера |

## Формат

`motion-records/<iso>_<tag>.jsonl`:

- meta / end
- sample @ ~20 Hz: `t_ms, yaw, pitch, fwd/back/left/right/jump/sneak, x,y,z, onGround`  
  yaw/pitch — радианы mineflayer

## Заметки

- Позицию зрителя **не** шлём на FunTime — только look + `player_input`; двигает физика бота.
- Пока `pilot` активен, anti-AFK бота пропускается.
- Sprint по умолчанию режется патчем ходьбы; `VIEW_PILOT_SPRINT=1` — разрешить в пилоте.
- На проде (502 orch) pilot **выкл**, пока не поставишь `VIEW_PILOT=1` в env оркестратора.
- Запись `motion-records/` — только эталон ритма мыши/W для тюнинга `afk-forward-look.mjs`, не реплей.
