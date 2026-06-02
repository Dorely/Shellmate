export function attachScroller(element) {
    if (!element) return;
    element.dataset.chatAutoFollow = 'true';
    element.addEventListener('scroll', () => {
        const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
        element.dataset.chatAutoFollow = distance < 80 ? 'true' : 'false';
    });
}

export function attachAutoSize(textarea) {
    if (!textarea) return;
    const resize = () => {
        textarea.style.height = 'auto';
        textarea.style.height = Math.min(textarea.scrollHeight, 180) + 'px';
    };
    textarea.addEventListener('input', resize);
    resize();
}

export function attachComposer(textarea) {
    if (!textarea) return;
    textarea.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.shiftKey) {
            const button = textarea.closest('.chat-surface')?.querySelector('[data-chat-send="true"]');
            if (button && !button.disabled) {
                event.preventDefault();
                button.click();
            }
        }
    });
}

export function resetComposer(textarea) {
    if (!textarea) return;
    textarea.value = '';
    textarea.style.height = 'auto';
}

export function scrollToBottom(element, force) {
    if (!element) return;
    if (force || element.dataset.chatAutoFollow !== 'false') {
        element.scrollTop = element.scrollHeight;
    }
}
