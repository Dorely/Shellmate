const instances = new WeakMap();

export function initialize(element, dotNetRef) {
    if (!element) return { cols: 80, rows: 24 };
    if (!globalThis.Terminal || !globalThis.FitAddon?.FitAddon) {
        throw new Error('xterm assets are not loaded.');
    }

    const terminal = new globalThis.Terminal({
        cursorBlink: true,
        fontFamily: '"Cascadia Mono", Consolas, "Liberation Mono", Menlo, monospace',
        fontSize: 13,
        scrollback: 5000,
        tabStopWidth: 4,
        theme: {
            background: '#0b1117',
            foreground: '#d1d5db',
            cursor: '#f9fafb',
            selectionBackground: '#1f6feb66',
            black: '#0b1117',
            red: '#ef4444',
            green: '#22c55e',
            yellow: '#eab308',
            blue: '#60a5fa',
            magenta: '#c084fc',
            cyan: '#2dd4bf',
            white: '#e5e7eb',
            brightBlack: '#4b5563',
            brightRed: '#f87171',
            brightGreen: '#86efac',
            brightYellow: '#fde047',
            brightBlue: '#93c5fd',
            brightMagenta: '#d8b4fe',
            brightCyan: '#67e8f9',
            brightWhite: '#f9fafb'
        }
    });
    const fitAddon = new globalThis.FitAddon.FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(element);

    const notifyResize = () => {
        dotNetRef.invokeMethodAsync('ReceiveResize', terminal.cols, terminal.rows).catch(() => {});
    };
    terminal.onData(data => dotNetRef.invokeMethodAsync('ReceiveInput', data).catch(() => {}));
    terminal.onResize(size => dotNetRef.invokeMethodAsync('ReceiveResize', size.cols, size.rows).catch(() => {}));

    const fit = () => {
        fitAddon.fit();
        notifyResize();
    };
    const resizeObserver = new ResizeObserver(() => fit());
    resizeObserver.observe(element);

    instances.set(element, { terminal, fitAddon, resizeObserver, dotNetRef });
    fit();
    terminal.focus();
    return { cols: terminal.cols, rows: terminal.rows };
}

export function write(element, data) {
    const instance = instances.get(element);
    if (!instance || !data) return;
    instance.terminal.write(data);
}

export function reset(element) {
    const instance = instances.get(element);
    if (!instance) return;
    instance.terminal.reset();
    instance.terminal.clear();
}

export function fit(element) {
    const instance = instances.get(element);
    if (!instance) return { cols: 80, rows: 24 };
    instance.fitAddon.fit();
    return { cols: instance.terminal.cols, rows: instance.terminal.rows };
}

export function focus(element) {
    const instance = instances.get(element);
    if (!instance) return;
    instance.terminal.focus();
}

export function dispose(element) {
    const instance = instances.get(element);
    if (!instance) return;
    instance.resizeObserver.disconnect();
    instance.terminal.dispose();
    instances.delete(element);
}
