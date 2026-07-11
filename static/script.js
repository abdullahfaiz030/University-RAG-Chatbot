// script.js
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

// ========== SIDEBAR OVERLAY & SWIPE ==========

let sidebarOverlay = null;

function createSidebarOverlay() {
    if (sidebarOverlay) return;
    sidebarOverlay = document.createElement('div');
    sidebarOverlay.className = 'sidebar-overlay';
    sidebarOverlay.onclick = closeSidebar;
    document.body.appendChild(sidebarOverlay);
}

function closeSidebar() {
    if (!sidebar) return;
    sidebar.classList.remove('open');
    if (sidebarOverlay) {
        sidebarOverlay.classList.remove('active');
    }
}

// Swipe handling for sidebar
let touchStartX = 0;
let touchCurrentX = 0;
let isSwiping = false;

if (sidebar) {
    sidebar.addEventListener('touchstart', function (e) {
        touchStartX = e.touches[0].clientX;
        isSwiping = true;
    }, { passive: true });

    sidebar.addEventListener('touchmove', function (e) {
        if (!isSwiping) return;
        touchCurrentX = e.touches[0].clientX;
        var diff = touchCurrentX - touchStartX;
        if (diff < 0 && sidebar.classList.contains('open')) {
            var translateX = Math.max(diff, -280);
            sidebar.style.transform = 'translateX(' + translateX + 'px)';
            sidebar.style.transition = 'none';
            sidebar.style.opacity = Math.max(1 - (Math.abs(diff) / 280), 0.3);
        }
    }, { passive: true });

    sidebar.addEventListener('touchend', function () {
        if (!isSwiping) return;
        isSwiping = false;
        var diff = touchCurrentX - touchStartX;
        sidebar.style.transform = '';
        sidebar.style.transition = '';
        sidebar.style.opacity = '';
        if (diff < -80 && sidebar.classList.contains('open')) {
            closeSidebar();
        }
    });

    // Click outside to close
    document.addEventListener('click', function (e) {
        if (sidebar.classList.contains('open') &&
            !sidebar.contains(e.target) &&
            e.target !== document.getElementById('sidebarToggle') &&
            !document.getElementById('sidebarToggle')?.contains(e.target)) {
            closeSidebar();
        }
    });

    // Escape key to close
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && sidebar.classList.contains('open')) {
            closeSidebar();
        }
    });
}

function toggleSidebar() {
    if (!sidebar) return;
    createSidebarOverlay();
    if (sidebar.classList.contains('open')) {
        closeSidebar();
    } else {
        sidebar.classList.add('open');
        if (sidebarOverlay) {
            sidebarOverlay.classList.add('active');
        }
    }
}

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

async function createNewSession(isInit) {
    if (isInit === undefined) isInit = false;

    var newSession = {
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
    closeSidebar();
}

function renderSessionsSidebar() {
    if (!sessionsListElement) return;
    sessionsListElement.innerHTML = '';
    chatSessions.forEach(function (session) {
        var item = document.createElement('div');
        item.className = 'session-item' + (session.id === sessionId ? ' active' : '');
        item.onclick = function () {
            selectSession(session.id);
            closeSidebar();
        };
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
    closeSidebar();
}

function loadSessionMessages(id) {
    var session = chatSessions.find(function (s) { return s.id === id; });
    if (!session) return;
    chatMessages.innerHTML = '';
    if (session.messages.length === 0) {
        startNewChat();
    } else {
        session.messages.forEach(function (msg) {
            addMessageToUi(msg.role === 'assistant' ? 'bot' : 'user', msg.content, msg.sources, msg.chart_data, msg.news_results, false);
        });
    }
}

async function saveMessageToHistory(role, content, sources, chartData, newsResults) {
    var session = chatSessions.find(function (s) { return s.id === sessionId; });
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
        session.messages.push({ role: role, content: content, sources: sources, chart_data: chartData, news_results: newsResults });
        saveSessionsToStorage();
    }
}

async function deleteSession(event, id) {
    event.stopPropagation();
    var index = chatSessions.findIndex(function (s) { return s.id === id; });
    if (index === -1) return;
    chatSessions.splice(index, 1);
    saveSessionsToStorage();

    try {
        await fetch('/api/sessions/' + id, { method: 'DELETE' });
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
        for (var i = 0; i < chatSessions.length; i++) {
            try {
                await fetch('/api/sessions/' + chatSessions[i].id, { method: 'DELETE' });
            } catch (e) { }
        }
        chatSessions = [];
        localStorage.removeItem('university_chatbot_sessions');
        await createNewSession(true);
        startNewChat();
        showToast('All chat history cleared');
    }
}

// ========== INITIALIZATION ==========

loadSessionsFromStorage();
checkSystemStatus();
initSpeechRecognition();

// ========== SPEECH RECOGNITION (FIXED) ==========

function initSpeechRecognition() {
    // Check for browser support
    var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognition) {
        console.warn('Speech Recognition API not supported in this browser');
        // Disable the microphone button
        if (voiceBtn) {
            voiceBtn.style.opacity = '0.5';
            voiceBtn.style.cursor = 'not-allowed';
            voiceBtn.title = 'Speech recognition not supported in this browser';
            voiceBtn.onclick = function () {
                showToast('Speech recognition is not supported in this browser');
            };
        }
        if (voiceStatus) {
            voiceStatus.textContent = 'Speech not supported';
        }
        return;
    }

    try {
        recognition = new SpeechRecognition();
        recognition.continuous = false;
        recognition.interimResults = true;
        recognition.lang = selectedLanguage;

        // Handle results
        recognition.onresult = function (event) {
            var transcript = '';
            for (var i = event.resultIndex; i < event.results.length; i++) {
                transcript += event.results[i][0].transcript;
            }
            userInput.value = transcript;

            // If this is a final result, stop listening
            if (event.results[0].isFinal) {
                stopListening();
            }
        };

        // Handle errors
        recognition.onerror = function (event) {
            console.error('Speech recognition error:', event.error);
            stopListening();

            switch (event.error) {
                case 'not-allowed':
                    showToast('Microphone access denied. Please allow microphone access in your browser settings.');
                    break;
                case 'no-speech':
                    showToast('No speech detected. Please try again.');
                    break;
                case 'audio-capture':
                    showToast('No microphone found. Please check your microphone connection.');
                    break;
                case 'network':
                    showToast('Network error. Please check your internet connection.');
                    break;
                default:
                    showToast('Speech recognition error: ' + event.error);
            }
        };

        // Handle when recognition ends
        recognition.onend = function () {
            // Only stop listening if we haven't already
            if (isListening) {
                stopListening();
            }
        };

        // Handle when recognition starts
        recognition.onstart = function () {
            console.log('Speech recognition started');
        };

        console.log('Speech recognition initialized successfully');

    } catch (error) {
        console.error('Failed to initialize speech recognition:', error);
        recognition = null;
        if (voiceBtn) {
            voiceBtn.style.opacity = '0.5';
            voiceBtn.style.cursor = 'not-allowed';
            voiceBtn.title = 'Failed to initialize speech recognition';
        }
    }
}

function toggleVoiceInput() {
    // Check if recognition is available
    if (!recognition) {
        showToast('Speech recognition is not available');
        return;
    }

    if (isListening) {
        stopListening();
    } else {
        startListening();
    }
}

function startListening() {
    if (!recognition) {
        showToast('Speech recognition is not available');
        return;
    }

    // Cancel any ongoing speech synthesis
    window.speechSynthesis.cancel();

    // Clear the input field
    userInput.value = '';

    // Set the language
    recognition.lang = selectedLanguage;

    // Update UI
    isListening = true;
    voiceBtn.classList.add('listening');
    voiceBtn.innerHTML = '<i class="fas fa-microphone-slash"></i>';
    voiceStatus.textContent = '🎙️ Listening...';

    // Start recognition
    try {
        recognition.start();
        console.log('Speech recognition started');
    } catch (error) {
        console.error('Error starting speech recognition:', error);
        stopListening();

        // If already started, stop and restart
        if (error.name === 'InvalidStateError') {
            try {
                recognition.stop();
                setTimeout(function () {
                    recognition.start();
                    isListening = true;
                    voiceBtn.classList.add('listening');
                    voiceBtn.innerHTML = '<i class="fas fa-microphone-slash"></i>';
                    voiceStatus.textContent = '🎙️ Listening...';
                }, 100);
            } catch (e) {
                console.error('Failed to restart recognition:', e);
                showToast('Failed to start microphone. Please try again.');
            }
        } else {
            showToast('Failed to start microphone. Please try again.');
        }
    }
}

function stopListening() {
    isListening = false;
    voiceBtn.classList.remove('listening');
    voiceBtn.innerHTML = '<i class="fas fa-microphone"></i>';
    voiceStatus.textContent = 'Click 🎤 for voice';

    // Stop recognition if it's running
    if (recognition) {
        try {
            recognition.stop();
        } catch (error) {
            // Ignore errors when stopping (might already be stopped)
            console.log('Error stopping recognition (may be already stopped):', error.message);
        }
    }
}

function changeLanguage() {
    selectedLanguage = languageSelect.value;
    if (recognition) {
        recognition.lang = selectedLanguage;
        // If currently listening, restart with new language
        if (isListening) {
            stopListening();
            setTimeout(function () {
                startListening();
            }, 200);
        }
    }
    showToast('Language: ' + languageSelect.options[languageSelect.selectedIndex].text);
}

async function checkSystemStatus() {
    try {
        var response = await fetch('/check-status');
        var data = await response.json();
        if (data.documents_available && data.document_count > 0) {
            docStatus.textContent = data.document_count + ' documents loaded';
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
    var toggleBtn = document.getElementById('voiceOutputToggle');
    if (toggleBtn) {
        var icon = toggleBtn.querySelector('i');
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
    var cleanText = text.replace(/\*\*(.*?)\*\*/g, '$1').replace(/__(.*?)__/g, '$1').replace(/#(.*?)\n/g, '$1\n').replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1').replace(/(https?:\/\/[^\s]+)/g, 'link').replace(/```[\s\S]*?```/g, '').replace(/`/g, '');
    var utterance = new SpeechSynthesisUtterance(cleanText);
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
    var message = userInput.value.trim();
    if (!message) return;
    isProcessing = true;
    addMessage('user', message);
    userInput.value = '';
    userInput.style.height = 'auto';
    var typingId = showTypingIndicator();
    sendBtn.disabled = true;
    var assistantDiv = null;
    var textEl = null;
    var fullText = '';
    var doneMeta = null;
    var lengthControl = lengthSelect ? lengthSelect.value : 'medium';

    try {
        var response = await fetch('/chat/stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: message, session_id: sessionId, language: selectedLanguage, length_control: lengthControl })
        });
        if (!response.ok || !response.body) throw new Error('Stream failed');
        var reader = response.body.getReader();
        var decoder = new TextDecoder();
        var buffer = '';
        while (true) {
            var result = await reader.read();
            if (result.done) break;
            buffer += decoder.decode(result.value, { stream: true });
            var events = buffer.split('\n\n');
            buffer = events.pop();
            for (var i = 0; i < events.length; i++) {
                var evt = events[i];
                if (!evt.startsWith('data: ')) continue;
                var payload;
                try { payload = JSON.parse(evt.slice(6)); } catch (e) { continue; }
                if (payload.delta) {
                    if (!assistantDiv) {
                        removeTypingIndicator(typingId);
                        assistantDiv = createBotMessageShell();
                        textEl = assistantDiv.querySelector('.message-text');
                    }
                    fullText += payload.delta;
                    textEl.innerHTML = formatMessage(fullText);
                    scrollToBottom();
                } else if (payload.error) {
                    removeTypingIndicator(typingId);
                    if (!assistantDiv) addMessage('bot', payload.error);
                    else { fullText = payload.error; textEl.innerHTML = formatMessage(fullText); }
                } else if (payload.done) {
                    doneMeta = payload;
                }
            }
        }
        if (assistantDiv) {
            finalizeBotMessage(assistantDiv, doneMeta || {});
            saveMessageToHistory('assistant', fullText, doneMeta ? doneMeta.sources : null);
        } else {
            removeTypingIndicator(typingId);
            addMessage('bot', 'Sorry, an error occurred.');
        }
    } catch (error) {
        removeTypingIndicator(typingId);
        if (assistantDiv && textEl && fullText) {
            finalizeBotMessage(assistantDiv, doneMeta || {});
            saveMessageToHistory('assistant', fullText, doneMeta ? doneMeta.sources : null);
        } else {
            addMessage('bot', '⚠️ Connection error.');
        }
    } finally {
        sendBtn.disabled = false;
        isProcessing = false;
        userInput.focus();
    }
}

function createBotMessageShell() {
    var messageDiv = document.createElement('div');
    messageDiv.className = 'message bot-message';
    var time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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
    var welcomeMsg = chatMessages.querySelector('.welcome-message');
    if (welcomeMsg) {
        welcomeMsg.style.animation = 'fadeOut 0.3s ease forwards';
        setTimeout(function () { welcomeMsg.remove(); }, 300);
    }
    chatMessages.appendChild(messageDiv);
    scrollToBottom();
    return messageDiv;
}

function finalizeBotMessage(messageDiv, meta) {
    var bubble = messageDiv.querySelector('.message-bubble');
    var metaContainer = bubble.querySelector('.message-meta');

    if (meta.sources && meta.sources.length > 0) {
        var sourcesEl = document.createElement('div');
        sourcesEl.className = 'message-sources';
        sourcesEl.innerHTML = '<i class="fas fa-file-alt"></i> Based on: ' + meta.sources.slice(0, 2).join(', ');
        bubble.insertBefore(sourcesEl, metaContainer);
    }

    if (meta.suggestions && meta.suggestions.length > 0) {
        var row = document.createElement('div');
        row.className = 'suggestion-chips';
        row.style.cssText = 'margin-top:10px;';
        meta.suggestions.forEach(function (s) {
            var chip = document.createElement('button');
            chip.className = 'chip';
            chip.innerHTML = '<i class="fas fa-comment-dots"></i> ' + escapeHtml(s);
            chip.onclick = function () { sendSuggestion(s); };
            row.appendChild(chip);
        });
        bubble.appendChild(row);
    }
    scrollToBottom();
}

function addMessage(type, content, sources, chartData, newsResults) {
    addMessageToUi(type, content, sources, chartData, newsResults, true);
}

function addMessageToUi(type, content, sources, chartData, newsResults, saveToHistory) {
    if (saveToHistory === undefined) saveToHistory = false;
    var messageDiv = document.createElement('div');
    messageDiv.className = 'message ' + type + '-message';
    var avatarHtml = type === 'user' ? '<i class="fas fa-user"></i>' : '<img src="' + LOGO_URL + '" alt="University Logo">';
    var time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    var actionButtonsHtml = type === 'bot' ? `
        <div style="display: flex; gap: 4px;">
            <button class="speak-btn" onclick="toggleSpeak(this)" title="Read Aloud"><i class="fas fa-volume-up"></i></button>
            <button class="copy-msg-btn" onclick="copyMessageText(this)" title="Copy"><i class="far fa-copy"></i></button>
        </div>` : '';

    var extrasHtml = '';
    if (sources && sources.length > 0) {
        extrasHtml += '<div class="message-sources"><i class="fas fa-file-alt"></i> Based on: ' + sources.slice(0, 2).join(', ') + '</div>';
    }

    messageDiv.innerHTML = `
        <div class="message-avatar">${avatarHtml}</div>
        <div class="message-bubble">
            <div class="message-text">${formatMessage(content)}</div>
            ${extrasHtml}
            <div class="message-meta"><span class="message-time">${time}</span>${actionButtonsHtml}</div>
        </div>`;
    var welcomeMsg = chatMessages.querySelector('.welcome-message');
    if (welcomeMsg) {
        welcomeMsg.style.animation = 'fadeOut 0.3s ease forwards';
        setTimeout(function () { welcomeMsg.remove(); }, 300);
    }
    chatMessages.appendChild(messageDiv);
    scrollToBottom();
    if (saveToHistory) saveMessageToHistory(type === 'bot' ? 'assistant' : 'user', content, sources, chartData, newsResults);
}

function formatMessage(text) {
    var escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    var codeBlocks = [];
    escaped = escaped.replace(/```(\w*)\n([\s\S]*?)```/g, function (match, lang, code) {
        var placeholder = '__CODE_BLOCK_PLACEHOLDER_' + codeBlocks.length + '__';
        codeBlocks.push({ lang: lang || 'code', code: code.trim() });
        return placeholder;
    });

    escaped = escaped.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');
    escaped = escaped.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

    var lines = escaped.split('\n');
    var inList = false;
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (line.startsWith('- ') || line.startsWith('* ')) {
            var content = line.substring(2);
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

    codeBlocks.forEach(function (block, index) {
        var blockHtml = '<div class="code-block-wrapper"><div class="code-block-header"><span>' + block.lang + '</span><button class="copy-code-btn" onclick="copyCodeText(this)"><i class="far fa-copy"></i> Copy</button></div><pre><code>' + block.code + '</code></pre></div>';
        escaped = escaped.replace('__CODE_BLOCK_PLACEHOLDER_' + index + '__', blockHtml);
    });

    return escaped;
}

function escapeHtml(str) {
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function copyCodeText(button) {
    var code = button.parentElement.nextElementSibling.querySelector('code');
    navigator.clipboard.writeText(code.textContent).then(function () {
        button.innerHTML = '<i class="fas fa-check"></i> Copied!';
        setTimeout(function () { button.innerHTML = '<i class="far fa-copy"></i> Copy'; }, 2000);
    });
}

function copyMessageText(button) {
    var text = button.closest('.message-bubble').querySelector('.message-text').textContent;
    navigator.clipboard.writeText(text).then(function () {
        button.innerHTML = '<i class="fas fa-check"></i>';
        showToast('Copied!');
        setTimeout(function () { button.innerHTML = '<i class="far fa-copy"></i>'; }, 2000);
    });
}

function toggleSpeak(button) {
    var text = button.closest('.message-bubble').querySelector('.message-text').textContent.replace(/https?:\/\/[^\s]+/g, '').trim();
    if (window.speechSynthesis.speaking) {
        window.speechSynthesis.cancel();
        if (currentSpeakButton) {
            currentSpeakButton.innerHTML = '<i class="fas fa-volume-up"></i>';
            currentSpeakButton.classList.remove('speaking');
        }
        if (currentSpeakButton === button) { currentSpeakButton = null; return; }
    }
    var utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = selectedLanguage || 'en';
    utterance.onend = function () {
        button.innerHTML = '<i class="fas fa-volume-up"></i>';
        button.classList.remove('speaking');
    };
    button.innerHTML = '<i class="fas fa-stop"></i>';
    button.classList.add('speaking');
    currentSpeakButton = button;
    window.speechSynthesis.speak(utterance);
}

// ========== UI HELPERS ==========

function showTypingIndicator() {
    var id = 'typing-' + Date.now();
    var div = document.createElement('div');
    div.className = 'message bot-message';
    div.id = id;
    div.innerHTML = '<div class="message-avatar"><img src="' + LOGO_URL + '" alt="University Logo"></div><div class="message-bubble"><div class="typing-indicator"><span></span><span></span><span></span></div></div>';
    chatMessages.appendChild(div);
    scrollToBottom();
    return id;
}

function removeTypingIndicator(id) {
    var el = document.getElementById(id);
    if (el) {
        el.style.animation = 'fadeOut 0.2s ease forwards';
        setTimeout(function () { el.remove(); }, 200);
    }
}

function handleKeyDown(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendMessage();
    }
}

function startNewChat() {
    chatMessages.innerHTML = '<div class="welcome-message"><div class="welcome-icon"><i class="fas fa-graduation-cap"></i></div><h3>Welcome to Your AI Study Assistant! 👋</h3><p>I\'m here to help you understand your course materials.</p><div class="suggestion-chips"><button onclick="sendSuggestion(\'What is a project?\')" class="chip"><i class="fas fa-bullseye"></i> What is a project?</button><button onclick="sendSuggestion(\'Explain the factors affecting software development\')" class="chip"><i class="fas fa-code"></i> Software development</button><button onclick="sendSuggestion(\'What are the key topics covered?\')" class="chip"><i class="fas fa-book-open"></i> Key topics</button><button onclick="sendSuggestion(\'Help me understand project stakeholders\')" class="chip"><i class="fas fa-users"></i> Project stakeholders</button></div></div>';
}

function scrollToBottom() {
    setTimeout(function () { chatMessages.scrollTop = chatMessages.scrollHeight; }, 50);
}

function exportCurrentChat() {
    var session = chatSessions.find(function (s) { return s.id === sessionId; });
    if (!session || session.messages.length === 0) { showToast('No messages to export'); return; }
    var text = '📝 Chat Export: ' + session.title + '\n==================================================\n\n';
    session.messages.forEach(function (msg) {
        text += (msg.role === 'assistant' ? '🤖 AI' : '👤 You') + ':\n' + msg.content + '\n\n--------------------------------------------------\n\n';
    });
    var blob = new Blob([text], { type: 'text/plain' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'chat_' + Date.now() + '.txt';
    a.click();
    showToast('Exported!');
}

function showToast(message) {
    var toast = document.createElement('div');
    toast.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:var(--primary);color:white;padding:10px 20px;border-radius:20px;font-size:13px;z-index:1000;';
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(function () {
        toast.style.opacity = '0';
        toast.style.transition = 'opacity 0.3s';
        setTimeout(function () { toast.remove(); }, 300);
    }, 2000);
}

// ========== TABS & FLASHCARDS ==========

var currentTab = 'chat';
var flashcardsDeck = [];
var currentCardIndex = 0;
var isGeneratingDeck = false;

function switchTab(tabName) {
    if (tabName === currentTab) return;
    currentTab = tabName;
    document.querySelectorAll('.tab-btn').forEach(function (b) { b.classList.remove('active'); });
    var tabMap = { 'chat': 'tabBtnChat', 'flashcards': 'tabBtnFlashcards', 'studyplan': 'tabBtnStudyPlan' };
    if (tabMap[tabName]) document.getElementById(tabMap[tabName]).classList.add('active');
    document.querySelectorAll('.tab-section').forEach(function (s) { s.classList.remove('active'); s.style.display = 'none'; });
    var secMap = { 'chat': 'chatSection', 'flashcards': 'flashcardsSection', 'studyplan': 'studyplanSection' };
    var sec = document.getElementById(secMap[tabName]);
    if (sec) { sec.classList.add('active'); sec.style.display = 'flex'; }
    if (tabName === 'chat') userInput.focus();
    else if (tabName === 'flashcards') document.getElementById('flashcardTopic').focus();
}

async function generateFlashcards() {
    if (isGeneratingDeck) return;
    var topic = document.getElementById('flashcardTopic').value.trim();
    isGeneratingDeck = true;
    document.getElementById('flashcardCard').classList.remove('flipped');
    document.getElementById('cardQuestion').innerHTML = '<i class="fas fa-spinner fa-spin"></i> Creating...';
    document.getElementById('cardAnswer').innerHTML = '<i class="fas fa-spinner fa-spin"></i> Creating...';
    document.getElementById('prevCardBtn').disabled = true;
    document.getElementById('nextCardBtn').disabled = true;
    try {
        var res = await fetch('/generate-flashcards', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ topic: topic }) });
        var data = await res.json();
        if (data.success && data.flashcards) { flashcardsDeck = data.flashcards; currentCardIndex = 0; renderCard(); }
        else { showCardError('Could not generate flashcards.'); }
    } catch (e) { showCardError('Connection error.'); }
    finally { isGeneratingDeck = false; }
}

function showCardError(msg) {
    flashcardsDeck = [];
    currentCardIndex = 0;
    document.getElementById('cardQuestion').innerHTML = '<div style="color:var(--error);">' + msg + '</div>';
    document.getElementById('cardAnswer').innerHTML = '';
    updateControls();
}

function renderCard() {
    if (!flashcardsDeck.length) return;
    document.getElementById('flashcardCard').classList.remove('flipped');
    setTimeout(function () {
        document.getElementById('cardQuestion').textContent = flashcardsDeck[currentCardIndex].question;
        document.getElementById('cardAnswer').textContent = flashcardsDeck[currentCardIndex].answer;
    }, 150);
    updateControls();
}

function updateControls() {
    var t = flashcardsDeck.length;
    document.getElementById('cardCounter').textContent = t ? 'Card ' + (currentCardIndex + 1) + ' of ' + t : 'Card 0 of 0';
    document.getElementById('prevCardBtn').disabled = t === 0 || currentCardIndex === 0;
    document.getElementById('nextCardBtn').disabled = t === 0 || currentCardIndex >= t - 1;
    document.getElementById('flashcardProgressBar').style.width = t ? (((currentCardIndex + 1) / t) * 100) + '%' : '0%';
}

function flipCard() {
    if (flashcardsDeck.length && !isGeneratingDeck) document.getElementById('flashcardCard').classList.toggle('flipped');
}

function nextCard() {
    if (currentCardIndex < flashcardsDeck.length - 1) { currentCardIndex++; renderCard(); }
}

function prevCard() {
    if (currentCardIndex > 0) { currentCardIndex--; renderCard(); }
}

document.addEventListener('keydown', function (e) {
    if (currentTab !== 'flashcards') return;
    if (document.activeElement === document.getElementById('flashcardTopic')) {
        if (e.key === 'Enter') { e.preventDefault(); generateFlashcards(); }
        return;
    }
    if (e.key === ' ') { e.preventDefault(); flipCard(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); nextCard(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); prevCard(); }
});

userInput.addEventListener('input', function () {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 120) + 'px';
});
userInput.focus();

var styleEl = document.createElement('style');
styleEl.textContent = '@keyframes fadeOut { from{opacity:1;transform:translateY(0);} to{opacity:0;transform:translateY(-10px);} }';
document.head.appendChild(styleEl);

// ========== STUDY PLAN GENERATOR ==========

function parseStudyPlanJSON(rawText) {
    var cleanText = rawText.trim();
    var match = cleanText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (match) { try { return JSON.parse(match[1].trim()); } catch (e) { } }
    cleanText = cleanText.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    var startIdx = cleanText.indexOf('{');
    var endIdx = cleanText.lastIndexOf('}');
    if (startIdx >= 0 && endIdx > startIdx) { try { return JSON.parse(cleanText.substring(startIdx, endIdx + 1)); } catch (e) { } }
    return null;
}

function formatAnyValue(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value.replace(/\n/g, '<br>');
    if (Array.isArray(value)) {
        return value.map(function (v) {
            if (typeof v === 'object' && v !== null) return JSON.stringify(v);
            return '• ' + v;
        }).join('<br>');
    }
    if (typeof value === 'object') {
        var html = '';
        for (var key in value) {
            if (value.hasOwnProperty(key)) {
                html += '<strong>' + key + ':</strong> ' + (typeof value[key] === 'string' ? value[key] : formatAnyValue(value[key])) + '<br>';
            }
        }
        return html;
    }
    return String(value);
}

async function generateStudyPlan() {
    var examDate = document.getElementById('studyExamDate').value;
    var subjects = document.getElementById('studySubjects').value.trim();
    var hoursPerDay = document.getElementById('studyHours').value;
    var btn = document.getElementById('generatePlanBtn');
    var resultDiv = document.getElementById('studyPlanResult');

    if (!examDate) { showToast('Please select your exam date'); return; }
    if (!subjects) { showToast('Please enter your subjects'); return; }

    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Generating Plan...';
    resultDiv.style.display = 'none';

    try {
        var response = await fetch('/generate-study-plan', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ exam_date: examDate, subjects: subjects, hours_per_day: parseInt(hoursPerDay) })
        });
        var data = await response.json();

        if (data.success && data.study_plan) {
            var plan = data.study_plan;

            if (plan.overview && typeof plan.overview === 'string' && plan.overview.includes('{')) {
                var parsed = parseStudyPlanJSON(plan.overview);
                if (parsed) {
                    plan = { ...plan, ...parsed, days_until_exam: plan.days_until_exam, total_study_hours: plan.total_study_hours, subjects: plan.subjects };
                }
            }

            if (typeof plan.overview === 'string') {
                plan.overview = plan.overview.replace(/```json[\s\S]*?```/g, '').replace(/```[\s\S]*?```/g, '').trim();
                var jsonStart = plan.overview.indexOf('{"');
                if (jsonStart > 0) plan.overview = plan.overview.substring(0, jsonStart).trim();
            }

            renderStudyPlan(plan);
            resultDiv.style.display = 'block';
            resultDiv.scrollIntoView({ behavior: 'smooth' });
            showToast('✅ Study plan generated!');
        } else {
            showToast(data.error || 'Failed to generate plan');
        }
    } catch (error) {
        console.error('Study plan error:', error);
        showToast('Connection error. Please try again.');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-magic"></i> Generate Study Plan';
    }
}

function renderStudyPlan(plan) {
    var overviewDiv = document.getElementById('planOverview');
    overviewDiv.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
            <i class="fas fa-lightbulb" style="font-size:20px;color:#f59e0b;"></i>
            <span style="font-weight:700;color:var(--text);font-size:16px;">Study Plan Overview</span>
        </div>
        <p style="color:var(--text-secondary);line-height:1.7;font-size:14px;">${plan.overview || 'Your personalized study plan is ready!'}</p>
        <div style="display:flex;gap:20px;margin-top:12px;flex-wrap:wrap;">
            <span style="background:white;padding:8px 16px;border-radius:20px;font-size:13px;font-weight:600;color:var(--primary);">📅 ${plan.days_until_exam} days</span>
            <span style="background:white;padding:8px 16px;border-radius:20px;font-size:13px;font-weight:600;color:var(--success);">⏰ ${plan.total_study_hours} hours</span>
        </div>`;

    var subjectsDiv = document.getElementById('planSubjects');
    if (plan.subjects_breakdown && plan.subjects_breakdown.length > 0) {
        var subjectsHTML = '<h4 style="margin-bottom:12px;color:var(--text);font-size:15px;">📚 Subject Breakdown</h4>';
        subjectsHTML += plan.subjects_breakdown.map(function (s) {
            var priorityColor = 'background:#dbeafe;color:#2563eb;';
            if (s.priority === 'High') priorityColor = 'background:#fee2e2;color:#dc2626;';
            else if (s.priority === 'Medium') priorityColor = 'background:#fef3c7;color:#d97706;';

            var topicsHTML = '';
            if (s.topics && s.topics.length > 0) {
                topicsHTML = '<div style="margin-top:8px;"><span style="font-size:12px;font-weight:600;color:var(--text);">📝 Key Topics:</span><div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:4px;">' +
                    s.topics.map(function (t) { return '<span style="background:var(--surface-light);padding:4px 10px;border-radius:15px;font-size:11px;color:var(--text-secondary);">' + t + '</span>'; }).join('') + '</div></div>';
            }

            var tipsText = '';
            if (s.tips) { tipsText = Array.isArray(s.tips) ? s.tips.join('; ') : String(s.tips); }

            return '<div style="background:var(--surface);border:1.5px solid #dbeafe;border-radius:12px;padding:18px;">' +
                '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">' +
                '<span style="font-weight:700;color:var(--text);font-size:15px;">' + (s.subject || 'Subject') + '</span>' +
                '<span style="padding:5px 12px;border-radius:20px;font-size:11px;font-weight:700;' + priorityColor + '">' + (s.priority || 'Medium') + ' Priority</span>' +
                '</div>' +
                '<p style="font-size:13px;color:var(--text-secondary);margin-bottom:6px;">⏱️ <strong>' + (s.total_hours || 0) + ' hours</strong></p>' +
                topicsHTML +
                (tipsText ? '<p style="font-size:12px;color:var(--primary);margin-top:8px;padding:8px;background:rgba(29,78,216,0.05);border-radius:8px;">💡 <strong>Tip:</strong> ' + tipsText + '</p>' : '') +
                '</div>';
        }).join('');
        subjectsDiv.innerHTML = subjectsHTML;
    }

    var weeklyDiv = document.getElementById('planWeekly');
    if (plan.weekly_plan && plan.weekly_plan.length > 0) {
        var weeklyHTML = '<h4 style="margin-bottom:14px;color:var(--text);font-size:15px;">📅 Weekly Schedule</h4>';
        weeklyHTML += plan.weekly_plan.map(function (w, i) {
            var tasksHTML = '';
            if (w.tasks && w.tasks.length > 0) {
                tasksHTML = '<div style="display:grid;gap:6px;margin-top:8px;">' + w.tasks.map(function (t) {
                    if (typeof t === 'object' && t.day) {
                        return '<div style="display:flex;gap:10px;padding:8px 12px;background:var(--surface-light);border-radius:8px;"><span style="font-weight:600;color:var(--primary);font-size:12px;min-width:50px;">Day ' + t.day + '</span><span style="font-size:12px;color:var(--text-secondary);">' + (t.task || '') + '</span></div>';
                    }
                    return '<div style="padding:8px 12px;background:var(--surface-light);border-radius:8px;font-size:12px;color:var(--text-secondary);"><i class="fas fa-check-circle" style="color:var(--success);margin-right:6px;"></i>' + t + '</div>';
                }).join('') + '</div>';
            }
            return '<div style="padding:12px 0;border-bottom:1px solid #dbeafe;"><div style="font-weight:700;color:var(--primary);font-size:14px;margin-bottom:6px;">Week ' + (w.week || (i + 1)) + ': ' + (w.focus || 'Study Focus') + '</div>' + tasksHTML + '</div>';
        }).join('');
        weeklyDiv.innerHTML = weeklyHTML;
    }

    var dailyDiv = document.getElementById('planDaily');
    if (plan.daily_schedule) {
        dailyDiv.innerHTML = '<h4 style="margin-bottom:12px;color:var(--text);font-size:15px;">📋 Daily Study Schedule</h4><div style="background:var(--surface-light);border-radius:12px;padding:18px;font-size:14px;color:var(--text-secondary);line-height:2;">' + formatAnyValue(plan.daily_schedule) + '</div>';
    } else {
        dailyDiv.innerHTML = '';
    }

    var tipsDiv = document.getElementById('planTips');
    var tipsHTML = '';
    if (plan.revision_strategy) {
        tipsHTML += '<div style="background:linear-gradient(135deg,#f0fdf4,#dcfce7);border:1.5px solid #bbf7d0;border-radius:12px;padding:18px;"><h4 style="color:#059669;margin-bottom:10px;font-size:14px;"><i class="fas fa-sync-alt"></i> Revision Strategy</h4><p style="font-size:13px;color:var(--text-secondary);line-height:1.7;">' + formatAnyValue(plan.revision_strategy) + '</p></div>';
    }
    if (plan.exam_day_tips) {
        tipsHTML += '<div style="background:linear-gradient(135deg,#fef3c7,#fde68a);border:1.5px solid #fcd34d;border-radius:12px;padding:18px;"><h4 style="color:#d97706;margin-bottom:10px;font-size:14px;"><i class="fas fa-star"></i> Exam Day Tips</h4><p style="font-size:13px;color:var(--text-secondary);line-height:1.7;">' + formatAnyValue(plan.exam_day_tips) + '</p></div>';
    }
    tipsDiv.innerHTML = tipsHTML;
}