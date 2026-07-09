const chatMessages = document.getElementById('chatMessages');
const userInput = document.getElementById('userInput');
const sendBtn = document.getElementById('sendBtn');
const docStatus = document.getElementById('docStatus');
const voiceBtn = document.getElementById('voiceBtn');
const voiceStatus = document.getElementById('voiceStatus');
const languageSelect = document.getElementById('languageSelect');
const sessionsListElement = document.getElementById('sessionsList');
const lengthSelect = document.getElementById('lengthSelect');
const sidebar = document.getElementById('sidebar');

let isProcessing = false;
let isListening = false;
let selectedLanguage = 'en';
let recognition = null;
let isVoiceOutputEnabled = true;

let currentUtterance = null;
let currentSpeakButton = null;

let chatSessions = [];
let sessionId = null;

const LOGO_URL = (function () {
    const el = document.querySelector('.bot-avatar img');
    return el ? el.getAttribute('src') : '/static/university_logo.png';
})();

// ========== SESSION MANAGEMENT ==========

async function loadSessionsFromStorage() {
    try {
        const response = await fetch('/api/sessions');
        const data = await response.json();
        if (data.success && data.sessions) {
            chatSessions = data.sessions;
        } else {
            chatSessions = [];
        }
    } catch (error) {
        console.error('Failed to load sessions:', error);
        chatSessions = [];
    }

    if (chatSessions.length === 0) {
        await createNewSession(true);
    } else {
        sessionId = chatSessions[0].id;
        renderSessionsSidebar();
        loadSessionMessages(sessionId);
    }
}

function saveSessionsToStorage() {
    localStorage.setItem('university_chatbot_sessions', JSON.stringify(chatSessions));
}

async function createNewSession(isInit = false) {
    const newSession = {
        id: 'sid-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9),
        title: 'New Chat',
        messages: [],
        timestamp: new Date().toISOString()
    };
    chatSessions.unshift(newSession);
    sessionId = newSession.id;

    try {
        await fetch('/api/sessions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: newSession.id, title: newSession.title })
        });
    } catch (error) {
        console.error('Failed to sync new session to backend:', error);
    }

    saveSessionsToStorage();
    renderSessionsSidebar();
    if (!isInit) {
        chatMessages.innerHTML = '';
        startNewChat();
        showToast('Started a new conversation');
    }
    if (sidebar && sidebar.classList.contains('open')) {
        sidebar.classList.remove('open');
    }
}

function renderSessionsSidebar() {
    if (!sessionsListElement) return;
    sessionsListElement.innerHTML = '';
    chatSessions.forEach(session => {
        const item = document.createElement('div');
        item.className = `session-item ${session.id === sessionId ? 'active' : ''}`;
        item.onclick = () => selectSession(session.id);
        item.innerHTML = `
            <span class="session-title"><i class="far fa-comments"></i> ${session.title}</span>
            <button class="delete-session-btn" onclick="deleteSession(event, '${session.id}')" title="Delete Chat">
                <i class="fas fa-trash"></i>
            </button>
        `;
        sessionsListElement.appendChild(item);
    });
}

function selectSession(id) {
    if (id === sessionId) return;
    sessionId = id;
    renderSessionsSidebar();
    loadSessionMessages(id);
    if (sidebar && sidebar.classList.contains('open')) sidebar.classList.remove('open');
}

function loadSessionMessages(id) {
    const session = chatSessions.find(s => s.id === id);
    if (!session) return;
    chatMessages.innerHTML = '';
    if (session.messages.length === 0) {
        startNewChat();
    } else {
        session.messages.forEach(msg => {
            addMessageToUi(msg.role === 'assistant' ? 'bot' : 'user', msg.content, msg.sources, msg.chart_data, msg.news_results, false);
        });
    }
}

async function saveMessageToHistory(role, content, sources = null, chartData = null, newsResults = null) {
    const session = chatSessions.find(s => s.id === sessionId);
    if (session) {
        if (session.messages.length === 0 && role === 'user') {
            session.title = content.substring(0, 30) + (content.length > 30 ? '...' : '');
            renderSessionsSidebar();
            try {
                await fetch('/api/sessions/update-title', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id: sessionId, title: session.title })
                });
            } catch (error) {
                console.error('Failed to sync session title:', error);
            }
        }
        session.messages.push({ role, content, sources, chart_data: chartData, news_results: newsResults });
        saveSessionsToStorage();
    }
}

async function deleteSession(event, id) {
    event.stopPropagation();
    const index = chatSessions.findIndex(s => s.id === id);
    if (index === -1) return;
    chatSessions.splice(index, 1);
    saveSessionsToStorage();

    try {
        await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
    } catch (error) {
        console.error('Failed to sync session deletion:', error);
    }

    if (id === sessionId) {
        if (chatSessions.length > 0) {
            sessionId = chatSessions[0].id;
            loadSessionMessages(sessionId);
        } else {
            await createNewSession(true);
        }
    }
    renderSessionsSidebar();
    showToast('Conversation deleted');
}

async function clearAllSessions() {
    if (confirm('Are you sure you want to delete all chat history?')) {
        for (const s of chatSessions) {
            try {
                await fetch(`/api/sessions/${s.id}`, { method: 'DELETE' });
            } catch (e) { }
        }
        chatSessions = [];
        localStorage.removeItem('university_chatbot_sessions');
        await createNewSession(true);
        startNewChat();
        showToast('All chat history cleared');
    }
}

function toggleSidebar() {
    if (sidebar) sidebar.classList.toggle('open');
}

// ========== INITIALIZATION ==========

loadSessionsFromStorage();
checkSystemStatus();
initSpeechRecognition();

function initSpeechRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SpeechRecognition) {
        recognition = new SpeechRecognition();
        recognition.continuous = false;
        recognition.interimResults = true;
        recognition.lang = selectedLanguage;
        recognition.onresult = (event) => {
            userInput.value = event.results[0][0].transcript;
        };
        recognition.onend = () => stopListening();
        recognition.onerror = () => stopListening();
    }
}

function toggleVoiceInput() {
    if (!recognition) return;
    if (isListening) { stopListening(); recognition.stop(); }
    else { window.speechSynthesis.cancel(); userInput.value = ''; try { recognition.start(); } catch (e) { } }
}

function startListening() {
    if (!recognition) return;
    recognition.lang = selectedLanguage;
    isListening = true;
    voiceBtn.classList.add('listening');
    voiceBtn.innerHTML = '<i class="fas fa-microphone-slash"></i>';
    voiceStatus.textContent = '🎙️ Listening...';
    recognition.start();
}

function stopListening() {
    isListening = false;
    voiceBtn.classList.remove('listening');
    voiceBtn.innerHTML = '<i class="fas fa-microphone"></i>';
    voiceStatus.textContent = 'Click 🎤 for voice';
    if (recognition) recognition.stop();
}

function changeLanguage() {
    selectedLanguage = languageSelect.value;
    if (recognition) recognition.lang = selectedLanguage;
    showToast(`Language: ${languageSelect.options[languageSelect.selectedIndex].text}`);
}

async function checkSystemStatus() {
    try {
        const response = await fetch('/check-status');
        const data = await response.json();
        if (data.documents_available && data.document_count > 0) {
            docStatus.textContent = `${data.document_count} documents loaded`;
            docStatus.style.color = '#22c55e';
            docStatus.style.background = 'rgba(34, 197, 94, 0.1)';
        } else {
            docStatus.textContent = 'No documents';
            docStatus.style.color = '#94a3b8';
            docStatus.style.background = 'rgba(148, 163, 184, 0.1)';
        }
    } catch (error) {
        docStatus.textContent = 'Connecting...';
        docStatus.style.color = '#f59e0b';
        docStatus.style.background = 'rgba(245, 158, 11, 0.1)';
    }
}

function toggleVoiceOutput() {
    isVoiceOutputEnabled = !isVoiceOutputEnabled;
    const toggleBtn = document.getElementById('voiceOutputToggle');
    if (toggleBtn) {
        const icon = toggleBtn.querySelector('i');
        if (isVoiceOutputEnabled) {
            toggleBtn.classList.add('active');
            icon.className = 'fas fa-volume-up';
        } else {
            toggleBtn.classList.remove('active');
            icon.className = 'fas fa-volume-mute';
            window.speechSynthesis.cancel();
        }
    }
}

function speakText(text) {
    if (!window.speechSynthesis || !isVoiceOutputEnabled) return;
    let cleanText = text.replace(/\*\*(.*?)\*\*/g, '$1').replace(/__(.*?)__/g, '$1').replace(/#(.*?)\n/g, '$1\n').replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1').replace(/(https?:\/\/[^\s]+)/g, 'link').replace(/```[\s\S]*?```/g, '').replace(/`/g, '');
    const utterance = new SpeechSynthesisUtterance(cleanText);
    utterance.lang = 'en-US';
    utterance.rate = 1.0;
    utterance.pitch = 1.0;
    window.speechSynthesis.speak(utterance);
}

// ========== MESSAGING ==========

function sendSuggestion(text) {
    userInput.value = text;
    userInput.focus();
    sendMessage();
}

async function sendMessage() {
    if (isProcessing) return;
    const message = userInput.value.trim();
    if (!message) return;
    isProcessing = true;
    addMessage('user', message);
    userInput.value = '';
    userInput.style.height = 'auto';
    const typingId = showTypingIndicator();
    sendBtn.disabled = true;
    let assistantDiv = null, textEl = null, fullText = '', doneMeta = null;
    const lengthControl = lengthSelect ? lengthSelect.value : 'medium';

    try {
        const response = await fetch('/chat/stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message, session_id: sessionId, language: selectedLanguage, length_control: lengthControl })
        });
        if (!response.ok || !response.body) throw new Error('Stream failed');
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const events = buffer.split('\n\n');
            buffer = events.pop();
            for (const evt of events) {
                if (!evt.startsWith('data: ')) continue;
                let payload;
                try { payload = JSON.parse(evt.slice(6)); } catch { continue; }
                if (payload.delta) {
                    if (!assistantDiv) { removeTypingIndicator(typingId); assistantDiv = createBotMessageShell(); textEl = assistantDiv.querySelector('.message-text'); }
                    fullText += payload.delta;
                    textEl.innerHTML = formatMessage(fullText);
                    scrollToBottom();
                } else if (payload.error) {
                    removeTypingIndicator(typingId);
                    if (!assistantDiv) addMessage('bot', payload.error);
                    else { fullText = payload.error; textEl.innerHTML = formatMessage(fullText); }
                } else if (payload.done) { doneMeta = payload; }
            }
        }
        if (assistantDiv) {
            finalizeBotMessage(assistantDiv, doneMeta || {});
            saveMessageToHistory('assistant', fullText, doneMeta ? doneMeta.sources : null);
        } else { removeTypingIndicator(typingId); addMessage('bot', 'Sorry, an error occurred.'); }
    } catch (error) {
        removeTypingIndicator(typingId);
        if (assistantDiv && textEl && fullText) {
            finalizeBotMessage(assistantDiv, doneMeta || {});
            saveMessageToHistory('assistant', fullText, doneMeta ? doneMeta.sources : null);
        } else { addMessage('bot', '⚠️ Connection error.'); }
    } finally {
        sendBtn.disabled = false;
        isProcessing = false;
        userInput.focus();
    }
}

function createBotMessageShell() {
    const messageDiv = document.createElement('div');
    messageDiv.className = 'message bot-message';
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    messageDiv.innerHTML = `
        <div class="message-avatar"><img src="${LOGO_URL}" alt="University Logo"></div>
        <div class="message-bubble">
            <div class="message-text"></div>
            <div class="message-meta">
                <span class="message-time">${time}</span>
                <div style="display: flex; gap: 4px;">
                    <button class="speak-btn" onclick="toggleSpeak(this)" title="Read Aloud"><i class="fas fa-volume-up"></i></button>
                    <button class="copy-msg-btn" onclick="copyMessageText(this)" title="Copy"><i class="far fa-copy"></i></button>
                </div>
            </div>
        </div>`;
    const welcomeMsg = chatMessages.querySelector('.welcome-message');
    if (welcomeMsg) { welcomeMsg.style.animation = 'fadeOut 0.3s ease forwards'; setTimeout(() => welcomeMsg.remove(), 300); }
    chatMessages.appendChild(messageDiv);
    scrollToBottom();
    return messageDiv;
}

function finalizeBotMessage(messageDiv, meta) {
    const bubble = messageDiv.querySelector('.message-bubble');
    const metaContainer = bubble.querySelector('.message-meta');

    if (meta.sources && meta.sources.length > 0) {
        const sourcesEl = document.createElement('div');
        sourcesEl.className = 'message-sources';
        sourcesEl.innerHTML = `<i class="fas fa-file-alt"></i> Based on: ${meta.sources.slice(0, 2).join(', ')}`;
        bubble.insertBefore(sourcesEl, metaContainer);
    }

    if (meta.suggestions && meta.suggestions.length > 0) {
        const row = document.createElement('div');
        row.className = 'suggestion-chips';
        row.style.cssText = 'margin-top:10px;';
        meta.suggestions.forEach(s => {
            const chip = document.createElement('button');
            chip.className = 'chip';
            chip.innerHTML = `<i class="fas fa-comment-dots"></i> ${escapeHtml(s)}`;
            chip.onclick = () => sendSuggestion(s);
            row.appendChild(chip);
        });
        bubble.appendChild(row);
    }
    scrollToBottom();
}

function addMessage(type, content, sources = null, chartData = null, newsResults = null) {
    addMessageToUi(type, content, sources, chartData, newsResults, true);
}

function addMessageToUi(type, content, sources = null, chartData = null, newsResults = null, saveToHistory = false) {
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${type}-message`;
    const avatarHtml = type === 'user' ? '<i class="fas fa-user"></i>' : `<img src="${LOGO_URL}" alt="University Logo">`;
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const actionButtonsHtml = type === 'bot' ? `
        <div style="display: flex; gap: 4px;">
            <button class="speak-btn" onclick="toggleSpeak(this)" title="Read Aloud"><i class="fas fa-volume-up"></i></button>
            <button class="copy-msg-btn" onclick="copyMessageText(this)" title="Copy"><i class="far fa-copy"></i></button>
        </div>` : '';

    let extrasHtml = '';
    if (sources && sources.length > 0) {
        extrasHtml += `<div class="message-sources"><i class="fas fa-file-alt"></i> Based on: ${sources.slice(0, 2).join(', ')}</div>`;
    }

    messageDiv.innerHTML = `
        <div class="message-avatar">${avatarHtml}</div>
        <div class="message-bubble">
            <div class="message-text">${formatMessage(content)}</div>
            ${extrasHtml}
            <div class="message-meta"><span class="message-time">${time}</span>${actionButtonsHtml}</div>
        </div>`;
    const welcomeMsg = chatMessages.querySelector('.welcome-message');
    if (welcomeMsg) { welcomeMsg.style.animation = 'fadeOut 0.3s ease forwards'; setTimeout(() => welcomeMsg.remove(), 300); }
    chatMessages.appendChild(messageDiv);
    scrollToBottom();
    if (saveToHistory) saveMessageToHistory(type === 'bot' ? 'assistant' : 'user', content, sources, chartData, newsResults);
}

function formatMessage(text) {
    let escaped = text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

    const codeBlocks = [];
    escaped = escaped.replace(/```(\w*)\n([\s\S]*?)```/g, function (match, lang, code) {
        const placeholder = `__CODE_BLOCK_PLACEHOLDER_${codeBlocks.length}__`;
        codeBlocks.push({ lang: lang || 'code', code: code.trim() });
        return placeholder;
    });

    escaped = escaped.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');
    escaped = escaped.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

    let lines = escaped.split('\n');
    let inList = false;
    for (let i = 0; i < lines.length; i++) {
        let line = lines[i].trim();
        if (line.startsWith('- ') || line.startsWith('* ')) {
            let content = line.substring(2);
            if (!inList) { lines[i] = '<ul><li>' + content + '</li>'; inList = true; }
            else { lines[i] = '<li>' + content + '</li>'; }
        } else {
            if (inList) { lines[i] = '</ul>' + lines[i]; inList = false; }
        }
    }
    if (inList) { lines.push('</ul>'); }
    escaped = lines.join('\n');
    escaped = escaped.replace(/\n/g, '<br>');
    escaped = escaped.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" style="color: #3b82f6; font-weight: 500;">$1</a>');

    codeBlocks.forEach((block, index) => {
        const blockHtml = `<div class="code-block-wrapper">
            <div class="code-block-header"><span>${block.lang}</span><button class="copy-code-btn" onclick="copyCodeText(this)"><i class="far fa-copy"></i> Copy</button></div>
            <pre><code>${block.code}</code></pre></div>`;
        escaped = escaped.replace(`__CODE_BLOCK_PLACEHOLDER_${index}__`, blockHtml);
    });

    return escaped;
}

function escapeHtml(str) { const div = document.createElement('div'); div.textContent = str; return div.innerHTML; }

function copyCodeText(button) {
    const code = button.parentElement.nextElementSibling.querySelector('code');
    navigator.clipboard.writeText(code.textContent).then(() => {
        button.innerHTML = '<i class="fas fa-check"></i> Copied!';
        setTimeout(() => { button.innerHTML = '<i class="far fa-copy"></i> Copy'; }, 2000);
    });
}

function copyMessageText(button) {
    const text = button.closest('.message-bubble').querySelector('.message-text').textContent;
    navigator.clipboard.writeText(text).then(() => {
        button.innerHTML = '<i class="fas fa-check"></i>';
        showToast('Copied!');
        setTimeout(() => { button.innerHTML = '<i class="far fa-copy"></i>'; }, 2000);
    });
}

function toggleSpeak(button) {
    const text = button.closest('.message-bubble').querySelector('.message-text').textContent.replace(/https?:\/\/[^\s]+/g, '').trim();
    if (window.speechSynthesis.speaking) {
        window.speechSynthesis.cancel();
        if (currentSpeakButton) { currentSpeakButton.innerHTML = '<i class="fas fa-volume-up"></i>'; currentSpeakButton.classList.remove('speaking'); }
        if (currentSpeakButton === button) { currentSpeakButton = null; return; }
    }
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = selectedLanguage || 'en';
    utterance.onend = () => { button.innerHTML = '<i class="fas fa-volume-up"></i>'; button.classList.remove('speaking'); };
    button.innerHTML = '<i class="fas fa-stop"></i>';
    button.classList.add('speaking');
    currentSpeakButton = button;
    window.speechSynthesis.speak(utterance);
}

// ========== UI HELPERS ==========

function showTypingIndicator() {
    const id = 'typing-' + Date.now();
    const div = document.createElement('div');
    div.className = 'message bot-message';
    div.id = id;
    div.innerHTML = `<div class="message-avatar"><img src="${LOGO_URL}" alt="University Logo"></div><div class="message-bubble"><div class="typing-indicator"><span></span><span></span><span></span></div></div>`;
    chatMessages.appendChild(div);
    scrollToBottom();
    return id;
}

function removeTypingIndicator(id) {
    const el = document.getElementById(id);
    if (el) { el.style.animation = 'fadeOut 0.2s ease forwards'; setTimeout(() => el.remove(), 200); }
}

function handleKeyDown(event) {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendMessage(); }
}

function startNewChat() {
    chatMessages.innerHTML = `<div class="welcome-message"><div class="welcome-icon"><i class="fas fa-graduation-cap"></i></div><h3>Welcome to Your AI Study Assistant! 👋</h3><p>I'm here to help you understand your course materials.</p><div class="suggestion-chips"><button onclick="sendSuggestion('What is a project?')" class="chip"><i class="fas fa-bullseye"></i> What is a project?</button><button onclick="sendSuggestion('Explain the factors affecting software development')" class="chip"><i class="fas fa-code"></i> Software development</button><button onclick="sendSuggestion('What are the key topics covered?')" class="chip"><i class="fas fa-book-open"></i> Key topics</button><button onclick="sendSuggestion('Help me understand project stakeholders')" class="chip"><i class="fas fa-users"></i> Project stakeholders</button></div></div>`;
}

function scrollToBottom() { setTimeout(() => { chatMessages.scrollTop = chatMessages.scrollHeight; }, 50); }

function exportCurrentChat() {
    const session = chatSessions.find(s => s.id === sessionId);
    if (!session || session.messages.length === 0) { showToast('No messages to export'); return; }
    let text = `📝 Chat Export: ${session.title}\n==================================================\n\n`;
    session.messages.forEach(msg => { text += `${msg.role === 'assistant' ? '🤖 AI' : '👤 You'}:\n${msg.content}\n\n--------------------------------------------------\n\n`; });
    const blob = new Blob([text], { type: 'text/plain' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `chat_${Date.now()}.txt`; a.click();
    showToast('Exported!');
}

function showToast(message) {
    const toast = document.createElement('div');
    toast.style.cssText = `position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:var(--primary);color:white;padding:10px 20px;border-radius:20px;font-size:13px;z-index:1000;`;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; toast.style.transition = 'opacity 0.3s'; setTimeout(() => toast.remove(), 300); }, 2000);
}

// ========== TABS & FLASHCARDS ==========

let currentTab = 'chat';
let flashcardsDeck = [];
let currentCardIndex = 0;
let isGeneratingDeck = false;

function switchTab(tabName) {
    if (tabName === currentTab) return;
    currentTab = tabName;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    const tabMap = { 'chat': 'tabBtnChat', 'flashcards': 'tabBtnFlashcards', 'studyplan': 'tabBtnStudyPlan' };
    if (tabMap[tabName]) document.getElementById(tabMap[tabName]).classList.add('active');
    document.querySelectorAll('.tab-section').forEach(s => { s.classList.remove('active'); s.style.display = 'none'; });
    const secMap = { 'chat': 'chatSection', 'flashcards': 'flashcardsSection', 'studyplan': 'studyplanSection' };
    const sec = document.getElementById(secMap[tabName]);
    if (sec) { sec.classList.add('active'); sec.style.display = 'flex'; }
    if (tabName === 'chat') userInput.focus();
    else if (tabName === 'flashcards') document.getElementById('flashcardTopic').focus();
}

async function generateFlashcards() {
    if (isGeneratingDeck) return;
    const topic = document.getElementById('flashcardTopic').value.trim();
    isGeneratingDeck = true;
    document.getElementById('flashcardCard').classList.remove('flipped');
    document.getElementById('cardQuestion').innerHTML = '<i class="fas fa-spinner fa-spin"></i> Creating...';
    document.getElementById('cardAnswer').innerHTML = '<i class="fas fa-spinner fa-spin"></i> Creating...';
    document.getElementById('prevCardBtn').disabled = true;
    document.getElementById('nextCardBtn').disabled = true;
    try {
        const res = await fetch('/generate-flashcards', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ topic }) });
        const data = await res.json();
        if (data.success && data.flashcards) { flashcardsDeck = data.flashcards; currentCardIndex = 0; renderCard(); }
        else { showCardError('Could not generate flashcards.'); }
    } catch { showCardError('Connection error.'); }
    finally { isGeneratingDeck = false; }
}

function showCardError(msg) { flashcardsDeck = []; currentCardIndex = 0; document.getElementById('cardQuestion').innerHTML = `<div style="color:var(--error);">${msg}</div>`; document.getElementById('cardAnswer').innerHTML = ''; updateControls(); }

function renderCard() {
    if (!flashcardsDeck.length) return;
    document.getElementById('flashcardCard').classList.remove('flipped');
    setTimeout(() => {
        document.getElementById('cardQuestion').textContent = flashcardsDeck[currentCardIndex].question;
        document.getElementById('cardAnswer').textContent = flashcardsDeck[currentCardIndex].answer;
    }, 150);
    updateControls();
}

function updateControls() {
    const t = flashcardsDeck.length;
    document.getElementById('cardCounter').textContent = t ? `Card ${currentCardIndex + 1} of ${t}` : 'Card 0 of 0';
    document.getElementById('prevCardBtn').disabled = t === 0 || currentCardIndex === 0;
    document.getElementById('nextCardBtn').disabled = t === 0 || currentCardIndex >= t - 1;
    document.getElementById('flashcardProgressBar').style.width = t ? `${((currentCardIndex + 1) / t) * 100}%` : '0%';
}

function flipCard() { if (flashcardsDeck.length && !isGeneratingDeck) document.getElementById('flashcardCard').classList.toggle('flipped'); }
function nextCard() { if (currentCardIndex < flashcardsDeck.length - 1) { currentCardIndex++; renderCard(); } }
function prevCard() { if (currentCardIndex > 0) { currentCardIndex--; renderCard(); } }

document.addEventListener('keydown', e => {
    if (currentTab !== 'flashcards') return;
    if (document.activeElement === document.getElementById('flashcardTopic')) { if (e.key === 'Enter') { e.preventDefault(); generateFlashcards(); } return; }
    if (e.key === ' ') { e.preventDefault(); flipCard(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); nextCard(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); prevCard(); }
});

// Auto-resize & focus
userInput.addEventListener('input', function () { this.style.height = 'auto'; this.style.height = Math.min(this.scrollHeight, 120) + 'px'; });
userInput.focus();

const style = document.createElement('style');
style.textContent = `@keyframes fadeOut { from{opacity:1;transform:translateY(0);} to{opacity:0;transform:translateY(-10px);} }`;
document.head.appendChild(style);

// ========== STUDY PLAN GENERATOR (FIXED) ==========

function parseStudyPlanJSON(rawText) {
    // Try multiple strategies to extract JSON from the response
    let cleanText = rawText.trim();

    // Strategy 1: Extract from markdown code block
    let match = cleanText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (match) {
        try { return JSON.parse(match[1].trim()); } catch (e) { }
    }

    // Strategy 2: Find the outermost JSON object
    let startIdx = cleanText.indexOf('{');
    let endIdx = cleanText.lastIndexOf('}');
    if (startIdx >= 0 && endIdx > startIdx) {
        try { return JSON.parse(cleanText.substring(startIdx, endIdx + 1)); } catch (e) { }
    }

    // Strategy 3: Remove markdown code fences and try again
    cleanText = cleanText.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    startIdx = cleanText.indexOf('{');
    endIdx = cleanText.lastIndexOf('}');
    if (startIdx >= 0 && endIdx > startIdx) {
        try { return JSON.parse(cleanText.substring(startIdx, endIdx + 1)); } catch (e) { }
    }

    return null;
}

async function generateStudyPlan() {
    const examDate = document.getElementById('studyExamDate').value;
    const subjects = document.getElementById('studySubjects').value.trim();
    const hoursPerDay = document.getElementById('studyHours').value;
    const btn = document.getElementById('generatePlanBtn');
    const resultDiv = document.getElementById('studyPlanResult');

    if (!examDate) { showToast('Please select your exam date'); return; }
    if (!subjects) { showToast('Please enter your subjects'); return; }

    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Generating Plan...';
    resultDiv.style.display = 'none';

    try {
        const response = await fetch('/generate-study-plan', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ exam_date: examDate, subjects: subjects, hours_per_day: parseInt(hoursPerDay) })
        });
        const data = await response.json();

        if (data.success && data.study_plan) {
            let plan = data.study_plan;

            // Try to parse JSON from the overview text
            if (plan.overview && typeof plan.overview === 'string' && plan.overview.includes('{')) {
                const parsed = parseStudyPlanJSON(plan.overview);
                if (parsed && parsed.subjects_breakdown) {
                    // The overview contained the full JSON - use it
                    plan = {
                        ...parsed,
                        days_until_exam: plan.days_until_exam,
                        total_study_hours: plan.total_study_hours,
                        subjects: plan.subjects
                    };
                } else if (parsed && parsed.overview) {
                    // Only the overview field was in JSON
                    plan.overview = parsed.overview;
                }
            }

            // Handle daily_schedule if it's an object
            if (plan.daily_schedule && typeof plan.daily_schedule === 'object') {
                let scheduleText = '';
                for (const [day, task] of Object.entries(plan.daily_schedule)) {
                    scheduleText += `<strong>${day}:</strong> ${task}<br>`;
                }
                plan.daily_schedule = scheduleText;
            }

            renderStudyPlan(plan);
            resultDiv.style.display = 'block';
            resultDiv.scrollIntoView({ behavior: 'smooth' });
            showToast('✅ Study plan generated!');
        } else {
            showToast(data.error || 'Failed to generate plan');
        }
    } catch (error) {
        showToast('Connection error. Please try again.');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-magic"></i> Generate Study Plan';
    }
}

function renderStudyPlan(plan) {
    // Overview Card
    const overviewDiv = document.getElementById('planOverview');
    overviewDiv.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
            <i class="fas fa-lightbulb" style="font-size:20px;color:#f59e0b;"></i>
            <span style="font-weight:700;color:var(--text);font-size:16px;">Study Plan Overview</span>
        </div>
        <p style="color:var(--text-secondary);line-height:1.7;font-size:14px;">${plan.overview || 'Your personalized study plan is ready!'}</p>
        <div style="display:flex;gap:20px;margin-top:12px;flex-wrap:wrap;">
            <span style="background:white;padding:8px 16px;border-radius:20px;font-size:13px;font-weight:600;color:var(--primary);">📅 ${plan.days_until_exam} days until exam</span>
            <span style="background:white;padding:8px 16px;border-radius:20px;font-size:13px;font-weight:600;color:var(--success);">⏰ ${plan.total_study_hours} total study hours</span>
        </div>
    `;

    // Subjects Breakdown
    const subjectsDiv = document.getElementById('planSubjects');
    if (plan.subjects_breakdown && plan.subjects_breakdown.length > 0) {
        subjectsDiv.innerHTML = '<h4 style="margin-bottom:12px;color:var(--text);font-size:15px;">📚 Subject Breakdown</h4>' +
            plan.subjects_breakdown.map(s => `
                <div style="background:var(--surface);border:1.5px solid #dbeafe;border-radius:12px;padding:18px;">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
                        <span style="font-weight:700;color:var(--text);font-size:15px;">${s.subject || 'Subject'}</span>
                        <span style="padding:5px 12px;border-radius:20px;font-size:11px;font-weight:700;${s.priority === 'High' ? 'background:#fee2e2;color:#dc2626;' : s.priority === 'Medium' ? 'background:#fef3c7;color:#d97706;' : 'background:#dbeafe;color:#2563eb;'}">${s.priority || 'Medium'} Priority</span>
                    </div>
                    <p style="font-size:13px;color:var(--text-secondary);margin-bottom:6px;">⏱️ <strong>${s.total_hours || 0} hours</strong> recommended</p>
                    ${s.topics ? `<div style="margin-top:8px;"><span style="font-size:12px;font-weight:600;color:var(--text);">📝 Key Topics:</span><div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:4px;">${s.topics.map(t => `<span style="background:var(--surface-light);padding:4px 10px;border-radius:15px;font-size:11px;color:var(--text-secondary);">${t}</span>`).join('')}</div></div>` : ''}
                    ${s.tips ? `<p style="font-size:12px;color:var(--primary);margin-top:8px;padding:8px;background:rgba(29,78,216,0.05);border-radius:8px;">💡 <strong>Tip:</strong> ${s.tips}</p>` : ''}
                </div>`).join('');
    }

    // Weekly Plan
    const weeklyDiv = document.getElementById('planWeekly');
    if (plan.weekly_plan && plan.weekly_plan.length > 0) {
        weeklyDiv.innerHTML = '<h4 style="margin-bottom:14px;color:var(--text);font-size:15px;">📅 Weekly Schedule</h4>' +
            plan.weekly_plan.map((w, i) => `
                <div style="padding:12px 0;border-bottom:1px solid #dbeafe;">
                    <div style="font-weight:700;color:var(--primary);font-size:14px;margin-bottom:6px;">Week ${w.week || i + 1}: ${w.focus || 'Study Focus'}</div>
                    ${w.tasks ? `<div style="display:grid;gap:6px;margin-top:8px;">${w.tasks.map(t => {
                if (typeof t === 'object') return `<div style="display:flex;gap:10px;padding:8px 12px;background:var(--surface-light);border-radius:8px;"><span style="font-weight:600;color:var(--primary);font-size:12px;min-width:50px;">Day ${t.day}</span><span style="font-size:12px;color:var(--text-secondary);">${t.task}</span></div>`;
                return `<div style="padding:8px 12px;background:var(--surface-light);border-radius:8px;font-size:12px;color:var(--text-secondary);"><i class="fas fa-check-circle" style="color:var(--success);margin-right:6px;"></i>${t}</div>`;
            }).join('')}</div>` : ''}
                </div>`).join('');
    }

    // Daily Schedule
    const dailyDiv = document.getElementById('planDaily');
    if (plan.daily_schedule) {
        let schedule = typeof plan.daily_schedule === 'string' ? plan.daily_schedule : JSON.stringify(plan.daily_schedule);
        schedule = schedule.replace(/\n/g, '<br>').replace(/^- /gm, '• ');
        dailyDiv.innerHTML = `<h4 style="margin-bottom:12px;color:var(--text);font-size:15px;">📋 Daily Study Schedule</h4><div style="background:var(--surface-light);border-radius:12px;padding:18px;font-size:14px;color:var(--text-secondary);line-height:2;">${schedule}</div>`;
    }

    // Tips Section
    const tipsDiv = document.getElementById('planTips');
    let tipsHTML = '';
    if (plan.revision_strategy) {
        tipsHTML += `<div style="background:linear-gradient(135deg,#f0fdf4,#dcfce7);border:1.5px solid #bbf7d0;border-radius:12px;padding:18px;"><h4 style="color:#059669;margin-bottom:10px;font-size:14px;"><i class="fas fa-sync-alt"></i> Revision Strategy</h4><p style="font-size:13px;color:var(--text-secondary);line-height:1.7;">${String(plan.revision_strategy).replace(/\n/g, '<br>')}</p></div>`;
    }
    if (plan.exam_day_tips) {
        tipsHTML += `<div style="background:linear-gradient(135deg,#fef3c7,#fde68a);border:1.5px solid #fcd34d;border-radius:12px;padding:18px;"><h4 style="color:#d97706;margin-bottom:10px;font-size:14px;"><i class="fas fa-star"></i> Exam Day Tips</h4><p style="font-size:13px;color:var(--text-secondary);line-height:1.7;">${String(plan.exam_day_tips).replace(/\n/g, '<br>')}</p></div>`;
    }
    tipsDiv.innerHTML = tipsHTML;
}