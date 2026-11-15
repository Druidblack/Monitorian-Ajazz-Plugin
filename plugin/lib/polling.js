'use strict';

// Single-flight refresh loop. A slow /get never causes a backlog of stale reads.
// setInterval is intentional: after an unusually slow read, the next available
// tick can run promptly instead of waiting one more interval after completion.
function startPolling({ tick, shouldRun = () => true, intervalMs = 1000, onError = () => {} } = {}) {
    if (typeof tick !== 'function') throw new TypeError('tick must be a function');
    if (!Number.isInteger(intervalMs) || intervalMs < 1) throw new RangeError('intervalMs must be positive');
    let stopped = false;
    let busy = false;
    const timer = setInterval(() => {
        if (stopped || busy || !shouldRun()) return;
        busy = true;
        // Defer execution so synchronous throws are handled consistently.
        Promise.resolve().then(tick).catch(onError).finally(() => { busy = false; });
    }, intervalMs);
    timer.unref?.();
    return () => {
        stopped = true;
        clearInterval(timer);
    };
}

module.exports = { startPolling };
