'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

// Monitorian CLI output, as documented by emoacht/Monitorian:
// [Device Instance ID] [Monitor name] [Brightness] B [*]
// Here the brackets denote fields, not literal characters. IDs don't contain spaces.
function parseBrightness(output) {
    const results = [];
    const lines = String(output || '').replace(/^\uFEFF/, '').split(/\r?\n/);
    for (let line of lines) {
        line = line.trim();
        if (!line) continue;
        const match = line.match(/^(\S+)\s+(.+?)\s+(\d{1,3})\s*B\s*(\*)?\s*$/i)
            || line.match(/^(\S+)\s+(.+?)\s+(\d{1,3})\s*(\*)?\s*B\s*$/i);
        if (!match) continue;
        const brightness = Number(match[3]);
        if (brightness > 100) continue;
        const id = match[1];
        const name = match[2].trim();
        results.push({ id, name, brightness, selected: Boolean(match[4]) });
    }
    return results;
}

function validateTarget(target) {
    if (target === 'linked' || target === 'premium-all' || target === 'all' || target === 'selected') return target;
    if (typeof target !== 'string' || !target || target.length > 500 || /[\r\n\0]/.test(target) || /^[-/]/.test(target)) {
        throw new Error('Неверный идентификатор монитора');
    }
    return target;
}

function validateExecutable(input) {
    const value = String(input || '').trim().replace(/^"(.*)"$/, '$1');
    if (!value) return '';
    if (value.length > 1000 || /[\r\n\0]/.test(value) || !/\.exe$/i.test(value)) {
        throw new Error('Укажите путь к Monitorian.exe');
    }
    return value;
}

function candidates(customPath, env = process.env) {
    const custom = validateExecutable(customPath);
    if (custom) return [custom];
    const result = [];
    if (env.LOCALAPPDATA) {
        result.push(path.win32.join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'Monitorian.exe'));
        result.push(path.win32.join(env.LOCALAPPDATA, 'Programs', 'Monitorian', 'Monitorian.exe'));
    }
    if (env.ProgramFiles) result.push(path.win32.join(env.ProgramFiles, 'Monitorian', 'Monitorian.exe'));
    if (env['ProgramFiles(x86)']) result.push(path.win32.join(env['ProgramFiles(x86)'], 'Monitorian', 'Monitorian.exe'));
    result.push('Monitorian.exe');
    return [...new Set(result)];
}

function execute(executable, args, exec = execFile) {
    return new Promise((resolve, reject) => {
        exec(executable, args, {
            encoding: 'utf8',
            timeout: 9000,
            maxBuffer: 128 * 1024,
            windowsHide: true,
            shell: false
        }, (error, stdout, stderr) => {
            if (error) {
                const detail = String(stderr || '').trim();
                if (detail) error.message += ': ' + detail.slice(0, 400);
                reject(error);
            } else resolve(String(stdout || ''));
        });
    });
}

class MonitorianClient {
    constructor({ env = process.env, exec = execFile, exists = fs.existsSync, platform = process.platform } = {}) {
        this.env = env;
        this.exec = exec;
        this.exists = exists;
        this.platform = platform;
        this.advancedCache = new Map();
    }

    async run(args, customPath = '') {
        if (this.platform !== 'win32') throw new Error('Monitorian работает только в Windows');
        const paths = candidates(customPath, this.env);
        let lastError;
        for (const exe of paths) {
            if (path.win32.isAbsolute(exe) && !this.exists(exe)) continue;
            try {
                const output = await execute(exe, args, this.exec);
                const rows = parseBrightness(output);
                if (!rows.length) {
                    const hint = String(output || '').trim().replace(/\s+/g, ' ').slice(0, 160);
                    throw new Error('Monitorian не вернул данные яркости. Проверьте работу команды /get в CMD.' + (hint ? ' Ответ: ' + hint : ''));
                }
                return rows;
            } catch (error) {
                if (error.code === 'ENOENT') {
                    lastError = error;
                    continue;
                }
                throw error;
            }
        }
        throw new Error('Monitorian.exe не найден. Установите Monitorian или укажите полный путь в настройках действия.' + (lastError ? ` (${lastError.code})` : ''));
    }

    // Unqualified CLI commands are usable with the basic Monitorian trial.
    // They address the last-selected Monitorian monitor, NOT a guaranteed set of all monitors.
    // We use 'linked' for this mode to avoid claiming the CLI controls a group.
    async ensureAdvanced(pathValue = '') {
        const last = this.advancedCache.get(pathValue);
        if (last && Date.now() - last.time < 5 * 60 * 1000) return last.rows;
        const rows = await this.run(['/get', 'all'], pathValue);
        // For multi-display use the unsubscribed Monitorian ignores the "all" selector.
        // In that case only the last-selected monitor is reported. Refuse writes to an
        // arbitrary monitor rather than silently operating on the wrong one.
        if (rows.length < 2) {
            throw new Error('Расширенная адресация мониторов не подтверждена: /get all вернул менее двух экранов. Используйте «Текущий монитор (/get и /set)»; для выбора всех или отдельного экрана нужен полноценный CLI Monitorian.');
        }
        this.advancedCache.set(pathValue, {rows, time: Date.now()});
        return rows;
    }

    async read(pathValue = '', target = 'linked') {
        validateTarget(target);
        if (target === 'linked' || target === 'all' || target === 'selected') {
            return this.run(['/get'], pathValue);
        }
        const rows = await this.ensureAdvanced(pathValue);
        if (target === 'premium-all') return rows;
        if (!rows.some(row => row.id === target)) {
            throw new Error('Монитор с указанным идентификатором не найден. Проверьте подключение и повторно получите список.');
        }
        const result = await this.run(['/get', target], pathValue);
        if (!result.some(row => row.id === target)) {
            throw new Error('Monitorian не подтвердил выбор заданного монитора. Яркость другого монитора менять не будем.');
        }
        return result;
    }

    async write(target, value, pathValue) {
        validateTarget(target);
        let args = ['/set', value];
        if (target !== 'linked' && target !== 'all' && target !== 'selected') {
            await this.ensureAdvanced(pathValue);
            if (target !== 'premium-all' && !this.advancedCache.get(pathValue).rows.some(row => row.id === target)) {
                throw new Error('Заданный монитор больше не обнаружен.');
            }
            args = ['/set', target === 'premium-all' ? 'all' : target, value];
        }
        const result = await this.run(args, pathValue);
        // The response only tells us what Monitorian reported, not that other
        // linked screens were actually changed. UI never claims group verification.
        return result;
    }

    change(target, delta, pathValue = '') {
        validateTarget(target);
        if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 100) {
            throw new Error('Шаг изменения яркости должен быть целым и от −100 до 100');
        }
        return this.write(target, delta > 0 ? `+${delta}` : String(delta), pathValue);
    }

    set(target, value, pathValue = '') {
        validateTarget(target);
        if (!Number.isInteger(value) || value < 0 || value > 100) throw new Error('Яркость должна быть от 0 до 100');
        return this.write(target, String(value), pathValue);
    }

}

module.exports = { MonitorianClient, parseBrightness, validateTarget, validateExecutable, candidates };
