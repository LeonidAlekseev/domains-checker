# domains-checker

Массовая проверка свободных доменов `.ru` из консоли. Два bash-скрипта, без зависимостей кроме `dig` и `curl`.

- `gen.sh` — генерирует имена по маске (`C` — согласная, `V` — гласная).
- `check.sh` — проверяет занятость: сначала быстро через DNS, затем оставшиеся через whois реестра.

## Установка

```sh
git clone https://github.com/LeonidAlekseev/domains-checker.git
cd domains-checker
# Debian/Ubuntu: sudo apt install dnsutils curl
# Fedora/RHEL:   sudo dnf install bind-utils curl
```

**Windows**: запускайте в [WSL](https://learn.microsoft.com/windows/wsl/install) (`wsl --install`, дальше как для Debian/Ubuntu). В Git Bash нет `dig`.

## Использование

```sh
echo "teef zvom" | ./check.sh
./gen.sh CVCV | ./check.sh > result.txt
CONS="b d l m n r t v" VOWS="a o e i" ./gen.sh CVCVC | ./check.sh
```

Имена подаются в stdin без `.ru`, через пробел, запятую или перевод строки.

### Формат вывода

| Строка | Значение |
|---|---|
| `FREE name` | домен свободен |
| `taken-delegated name` | занят, есть NS-записи |
| `taken-whois name (STATE)` | зарегистрирован, но не делегирован |
| `ERR name` | whois не ответил — перезапустите для этих имён |

Только свободные: `grep ^FREE result.txt`.

## Как работает

1. **DNS**: запрос NS через `1.1.1.1`, 40 потоков. Есть NS — домен занят.
2. **whois**: оставшиеся имена проверяются через `whois.ru` — ловит зарегистрированные, но не делегированные домены.

## Настройки

| Переменная | По умолчанию | Описание |
|---|---|---|
| `WHOIS_P` | `2` | потоков whois. whois.ru показывает капчу после нескольких тысяч быстрых запросов — держите низким |
| `CONS` | `b d f l m n p r t v z` | согласные для `gen.sh` |
| `VOWS` | `a o e` | гласные для `gen.sh` |

Если в stderr появилось `captcha: whois.ru blocked` — остановитесь и повторите позже.

## Лицензия

[MIT](LICENSE)
