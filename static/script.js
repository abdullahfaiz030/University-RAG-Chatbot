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

// Speech Synthesis (Read Aloud) Globals
let currentUtterance = null;
let currentSpeakButton = null;

// Session Management Globals
let chatSessions = [];
let sessionId = null;

// ========== SESSION MANAGEMENT ==========

function loadSessionsFromStorage() {
    const data = localStorage.getItem('university_chatbot_sessions');
    if (data) {
        try { chatSessions = JSON.parse(data); }
        catch (e) { chatSessions = []; }
    }
    if (chatSessions.length === 0) {
        createNewSession(true);
    } else {
        sessionId = chatSessions[0].id;
        renderSessionsSidebar();
        loadSessionMessages(sessionId);
    }
}

function saveSessionsToStorage() {
    localStorage.setItem('university_chatbot_sessions', JSON.stringify(chatSessions));
}

function createNewSession(isInit = false) {
    const newSession = {
        id: 'sid-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9),
        title: 'New Chat',
        messages: [],
        timestamp: new Date().toISOString()
    };
    chatSessions.unshift(newSession);
    sessionId = newSession.id;
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

function saveMessageToHistory(role, content, sources = null, chartData = null, newsResults = null) {
    const session = chatSessions.find(s => s.id === sessionId);
    if (session) {
        if (session.messages.length === 0 && role === 'user') {
            session.title = content.substring(0, 30) + (content.length > 30 ? '...' : '');
            renderSessionsSidebar();
        }
        session.messages.push({ role, content, sources, chart_data: chartData, news_results: newsResults });
        saveSessionsToStorage();
    }
}

function deleteSession(event, id) {
    event.stopPropagation();
    const index = chatSessions.findIndex(s => s.id === id);
    if (index === -1) return;
    chatSessions.splice(index, 1);
    saveSessionsToStorage();
    fetch('/clear-history', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_id: id }) }).catch(() => { });
    if (id === sessionId) {
        if (chatSessions.length > 0) {
            sessionId = chatSessions[0].id;
            loadSessionMessages(sessionId);
        } else {
            createNewSession(true);
        }
    }
    renderSessionsSidebar();
    showToast('Conversation deleted');
}

function clearAllSessions() {
    if (confirm('Are you sure you want to delete all chat history?')) {
        chatSessions.forEach(s => {
            fetch('/clear-history', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_id: s.id }) }).catch(() => { });
        });
        chatSessions = [];
        localStorage.removeItem('university_chatbot_sessions');
        createNewSession(true);
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

// ========== VOICE OUTPUT TOGGLE ==========

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
            saveMessageToHistory('assistant', fullText);
        } else { removeTypingIndicator(typingId); addMessage('bot', 'Sorry, an error occurred.'); }
    } catch (error) {
        removeTypingIndicator(typingId);
        if (assistantDiv && textEl && fullText) {
            finalizeBotMessage(assistantDiv, doneMeta || {});
            saveMessageToHistory('assistant', fullText);
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
        <div class="message-avatar"><img src="/static/university_logo.png" alt="University Logo"></div>
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
    const avatarHtml = type === 'user' ? '<i class="fas fa-user"></i>' : '<img src="/static/university_logo.png" alt="University Logo">';
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const actionButtonsHtml = type === 'bot' ? `
        <div style="display: flex; gap: 4px;">
            <button class="speak-btn" onclick="toggleSpeak(this)" title="Read Aloud"><i class="fas fa-volume-up"></i></button>
            <button class="copy-msg-btn" onclick="copyMessageText(this)" title="Copy"><i class="far fa-copy"></i></button>
        </div>` : '';
    messageDiv.innerHTML = `
        <div class="message-avatar">${avatarHtml}</div>
        <div class="message-bubble">
            <div class="message-text">${formatMessage(content)}</div>
            <div class="message-meta"><span class="message-time">${time}</span>${actionButtonsHtml}</div>
        </div>`;
    const welcomeMsg = chatMessages.querySelector('.welcome-message');
    if (welcomeMsg) { welcomeMsg.style.animation = 'fadeOut 0.3s ease forwards'; setTimeout(() => welcomeMsg.remove(), 300); }
    chatMessages.appendChild(messageDiv);
    scrollToBottom();
    if (saveToHistory) saveMessageToHistory(type === 'bot' ? 'assistant' : 'user', content, sources, chartData, newsResults);
}

function formatMessage(text) {
    let escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    escaped = escaped.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => `<div class="code-block-wrapper"><div class="code-block-header"><span>${lang || 'code'}</span><button class="copy-code-btn" onclick="copyCodeText(this)"><i class="far fa-copy"></i> Copy</button></div><pre><code>${code.trim()}</code></pre></div>`);
    escaped = escaped.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');
    escaped = escaped.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    escaped = escaped.replace(/\n/g, '<br>');
    escaped = escaped.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" style="color: #818cf8;">$1</a>');
    return escaped;
}

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
    div.innerHTML = `<div class="message-avatar"><img src="/static/university_logo.png" alt="University Logo"></div><div class="message-bubble"><div class="typing-indicator"><span></span><span></span><span></span></div></div>`;
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

function escapeHtml(str) { const d = document.createElement('div'); d.textContent = str; return d.innerHTML; }

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
    document.getElementById(tabName === 'chat' ? 'tabBtnChat' : 'tabBtnFlashcards').classList.add('active');
    document.querySelectorAll('.tab-section').forEach(s => { s.classList.remove('active'); s.style.display = 'none'; });
    const sec = document.getElementById(`${tabName}Section`);
    sec.classList.add('active');
    sec.style.display = 'flex';
    if (tabName === 'chat') userInput.focus();
    else document.getElementById('flashcardTopic').focus();
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