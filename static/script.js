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
        touchCurrentX = touchStartX; // Prevent stale or zero touchCurrentX on tap
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

    // Prevent duplicate empty sessions by reusing any existing empty session
    if (!isInit) {
        var emptySession = chatSessions.find(function (s) { return s.messages.length === 0; });
        if (emptySession) {
            selectSession(emptySession.id);
            closeSidebar();
            userInput.focus();
            return;
        }
    }

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
            addMessageToUi(msg.role === 'assistant' ? 'bot' : 'user', msg.content, msg.sources, msg.chart_data, msg.news_results, false, msg.sentiment, msg.image_data);
        });
    }
}

async function saveMessageToHistory(role, content, sources, chartData, newsResults, sentiment, imageData) {
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
        session.messages.push({ role: role, content: content, sources: sources, chart_data: chartData, news_results: newsResults, sentiment: sentiment, image_data: imageData });
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

// ========== THEME TOGGLING ==========
function initTheme() {
    var savedTheme = localStorage.getItem('theme');
    var toggleBtn = document.getElementById('themeToggleBtn');
    if (savedTheme === 'dark') {
        document.body.classList.add('dark-theme');
        if (toggleBtn) toggleBtn.innerHTML = '<i class="fas fa-sun"></i>';
    } else {
        document.body.classList.remove('dark-theme');
        if (toggleBtn) toggleBtn.innerHTML = '<i class="fas fa-moon"></i>';
    }
}

function toggleTheme() {
    var toggleBtn = document.getElementById('themeToggleBtn');
    if (document.body.classList.contains('dark-theme')) {
        document.body.classList.remove('dark-theme');
        localStorage.setItem('theme', 'light');
        if (toggleBtn) toggleBtn.innerHTML = '<i class="fas fa-moon"></i>';
        showToast('Switched to Light Theme');
    } else {
        document.body.classList.add('dark-theme');
        localStorage.setItem('theme', 'dark');
        if (toggleBtn) toggleBtn.innerHTML = '<i class="fas fa-sun"></i>';
        showToast('Switched to Dark Theme');
    }
}

// ========== INITIALIZATION ==========

let isAppInitialized = false;

function initializeApp() {
    if (isAppInitialized) return;
    isAppInitialized = true;
    initTheme();
    loadStats();
    initSpeechRecognition();
    loadSessionsFromStorage();
    checkSystemStatus();
}

document.addEventListener('DOMContentLoaded', initializeApp);

if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(initializeApp, 100);
}

// ========== SPEECH RECOGNITION ==========

function initSpeechRecognition() {
    console.log('Initializing speech recognition...');
    var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognition) {
        console.warn('Speech Recognition API not supported in this browser');
        if (voiceBtn) {
            voiceBtn.style.opacity = '0.5';
            voiceBtn.style.cursor = 'not-allowed';
            voiceBtn.title = 'Speech recognition not supported in this browser';
            voiceBtn.onclick = function () {
                showToast('Speech recognition is not supported in this browser. Please use Chrome or Edge.');
            };
        }
        if (voiceStatus) {
            voiceStatus.textContent = 'Not supported';
        }
        return;
    }

    try {
        recognition = new SpeechRecognition();
        recognition.continuous = false;
        recognition.interimResults = true;
        recognition.lang = selectedLanguage;
        recognition.maxAlternatives = 1;

        recognition.onresult = function (event) {
            console.log('Speech recognition result received:', event);
            var transcript = '';
            for (var i = event.resultIndex; i < event.results.length; i++) {
                if (event.results[i].isFinal) {
                    transcript += event.results[i][0].transcript;
                } else {
                    transcript += event.results[i][0].transcript;
                }
            }
            userInput.value = transcript;
            if (event.results[0] && event.results[0].isFinal) {
                console.log('Final result, stopping recognition');
                stopListening();
            }
        };

        recognition.onerror = function (event) {
            console.error('Speech recognition error:', event.error, event.message);
            switch (event.error) {
                case 'not-allowed':
                case 'permission-denied':
                    showToast('Microphone access denied. Please allow microphone access in your browser settings.');
                    break;
                case 'no-speech':
                    showToast('No speech detected. Please try again.');
                    break;
                case 'audio-capture':
                    showToast('No microphone found. Please check your microphone connection.');
                    break;
                case 'network':
                    showToast('Network error. Speech recognition requires internet connection.');
                    break;
                case 'aborted':
                    console.log('Recognition aborted');
                    break;
                default:
                    showToast('Speech recognition error: ' + event.error);
            }
            stopListening();
        };

        recognition.onend = function () {
            console.log('Speech recognition ended');
            if (isListening) {
                stopListening();
            }
        };

        recognition.onstart = function () {
            console.log('Speech recognition started successfully');
        };

        console.log('Speech recognition initialized successfully');

        if (voiceBtn) {
            voiceBtn.style.opacity = '1';
            voiceBtn.style.cursor = 'pointer';
            voiceBtn.onclick = toggleVoiceInput;
            voiceBtn.title = 'Click to start voice input';
        }
        if (voiceStatus) {
            voiceStatus.textContent = 'Click 🎤 for voice';
        }

    } catch (error) {
        console.error('Failed to initialize speech recognition:', error);
        recognition = null;
        if (voiceBtn) {
            voiceBtn.style.opacity = '0.5';
            voiceBtn.style.cursor = 'not-allowed';
            voiceBtn.title = 'Failed to initialize speech recognition: ' + error.message;
        }
        if (voiceStatus) {
            voiceStatus.textContent = 'Init failed';
        }
    }
}

function toggleVoiceInput() {
    console.log('Toggle voice input called, isListening:', isListening);
    console.log('Recognition object:', recognition);
    if (!recognition) {
        showToast('Speech recognition is not available');
        initSpeechRecognition();
        return;
    }
    if (isListening) {
        stopListening();
    } else {
        startListening();
    }
}

function startListening() {
    console.log('Starting listening...');
    if (!recognition) {
        showToast('Speech recognition is not available');
        initSpeechRecognition();
        return;
    }
    if (window.speechSynthesis) {
        window.speechSynthesis.cancel();
    }
    userInput.value = '';
    recognition.lang = selectedLanguage;
    isListening = true;
    if (voiceBtn) {
        voiceBtn.classList.add('listening');
        voiceBtn.innerHTML = '<i class="fas fa-microphone-slash"></i>';
    }
    if (voiceStatus) {
        voiceStatus.textContent = '🎙️ Listening...';
    }
    setTimeout(function () {
        try {
            recognition.start();
            console.log('Speech recognition start command sent');
        } catch (error) {
            console.error('Error starting speech recognition:', error);
            if (error.name === 'InvalidStateError' || error.message.includes('already started')) {
                console.log('Recognition already started, stopping first...');
                try {
                    recognition.stop();
                    setTimeout(function () {
                        try {
                            recognition.start();
                            console.log('Recognition restarted successfully');
                        } catch (e) {
                            console.error('Failed to restart recognition:', e);
                            stopListening();
                            showToast('Failed to start microphone. Please try again.');
                        }
                    }, 100);
                } catch (stopError) {
                    console.error('Error stopping recognition:', stopError);
                    stopListening();
                    showToast('Failed to start microphone. Please try again.');
                }
            } else {
                stopListening();
                showToast('Failed to start microphone: ' + error.message);
            }
        }
    }, 50);
}

function stopListening() {
    console.log('Stopping listening...');
    isListening = false;
    if (voiceBtn) {
        voiceBtn.classList.remove('listening');
        voiceBtn.innerHTML = '<i class="fas fa-microphone"></i>';
    }
    if (voiceStatus) {
        voiceStatus.textContent = 'Click 🎤 for voice';
    }
    if (recognition) {
        try {
            recognition.stop();
            console.log('Recognition stopped');
        } catch (error) {
            console.log('Error stopping recognition (may be already stopped):', error.message);
        }
    }
}

function changeLanguage() {
    selectedLanguage = languageSelect.value;
    if (recognition) {
        recognition.lang = selectedLanguage;
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
    if (!message && !selectedImageData) return;
    isProcessing = true;
    
    var imgDataToSend = selectedImageData;
    var imgMimeToSend = selectedImageMime;
    var imgFullSrc = imgDataToSend ? `data:${imgMimeToSend};base64,${imgDataToSend}` : null;
    
    addMessage('user', message, null, null, null, null, imgFullSrc);
    incrementStat('questionsAsked');
    clearSelectedImage();
    
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
            body: JSON.stringify({ 
                message: message, 
                session_id: sessionId, 
                language: selectedLanguage, 
                length_control: lengthControl,
                image_data: imgDataToSend,
                image_mime: imgMimeToSend
            })
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
            saveMessageToHistory('assistant', fullText, doneMeta ? doneMeta.sources : null, null, null, doneMeta ? doneMeta.sentiment : null);
        } else {
            removeTypingIndicator(typingId);
            addMessage('bot', 'Sorry, an error occurred.');
        }
    } catch (error) {
        removeTypingIndicator(typingId);
        if (assistantDiv && textEl && fullText) {
            finalizeBotMessage(assistantDiv, doneMeta || {});
            saveMessageToHistory('assistant', fullText, doneMeta ? doneMeta.sources : null, null, null, doneMeta ? doneMeta.sentiment : null);
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

function finalizeBotMessage(messageDiv, meta, rawText) {
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

    // Dynamic Sentiment Badge
    if (meta.sentiment && meta.sentiment !== 'neutral') {
        var sentimentEmoji = '';
        var sentimentText = '';
        if (meta.sentiment === 'positive') { sentimentEmoji = '😊'; sentimentText = 'Happy'; }
        else if (meta.sentiment === 'negative') { sentimentEmoji = '😟'; sentimentText = 'Sad'; }
        else if (meta.sentiment === 'frustrated') { sentimentEmoji = '🤯'; sentimentText = 'Frustrated'; }
        
        var actionsDiv = metaContainer.querySelector('div');
        if (actionsDiv) {
            var badge = document.createElement('span');
            badge.className = 'sentiment-badge sentiment-' + meta.sentiment;
            badge.title = 'Mood: ' + sentimentText;
            badge.innerHTML = sentimentEmoji + ' ' + sentimentText;
            actionsDiv.insertBefore(badge, actionsDiv.firstChild);
        }
    }

    // Render interactive chart if data is present
    renderChartIfPresent(messageDiv, rawText);

    scrollToBottom();
}

function renderChartIfPresent(messageDiv, content) {
    if (!content) return;
    var match = content.match(/\[CHART:\s*(\{[\s\S]*?\})\s*\]/);
    if (!match) return;
    
    try {
        var chartConfig = JSON.parse(match[1]);
        var bubble = messageDiv.querySelector('.message-bubble');
        var metaContainer = bubble.querySelector('.message-meta');
        
        // Remove existing chart-wrapper if present to avoid duplicate renderings on reload
        var existingWrapper = bubble.querySelector('.chart-wrapper');
        if (existingWrapper) {
            existingWrapper.remove();
        }
        
        var wrapper = document.createElement('div');
        wrapper.className = 'chart-wrapper';
        
        var canvas = document.createElement('canvas');
        canvas.style.cssText = 'max-width: 100%; height: auto; display: block;';
        wrapper.appendChild(canvas);
        
        bubble.insertBefore(wrapper, metaContainer);
        
        var ctx = canvas.getContext('2d');
        new Chart(ctx, {
            type: chartConfig.type || 'bar',
            data: {
                labels: chartConfig.labels || [],
                datasets: [{
                    label: chartConfig.title || 'Data Comparison',
                    data: chartConfig.data || [],
                    backgroundColor: [
                        'rgba(59, 130, 246, 0.65)',
                        'rgba(16, 185, 129, 0.65)',
                        'rgba(245, 158, 11, 0.65)',
                        'rgba(239, 68, 68, 0.65)',
                        'rgba(139, 92, 246, 0.65)'
                    ],
                    borderColor: [
                        '#3b82f6',
                        '#10b981',
                        '#f59e0b',
                        '#ef4444',
                        '#8b5cf6'
                    ],
                    borderWidth: 1.5
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: true,
                plugins: {
                    legend: {
                        display: ['pie', 'doughnut'].includes(chartConfig.type)
                    }
                },
                scales: ['pie', 'doughnut'].includes(chartConfig.type) ? {} : {
                    y: {
                        beginAtZero: true
                    }
                }
            }
        });
    } catch (e) {
        console.error('Failed to render chart:', e);
    }
}

function addMessage(type, content, sources, chartData, newsResults, sentiment, imageData) {
    addMessageToUi(type, content, sources, chartData, newsResults, true, sentiment, imageData);
}

function addMessageToUi(type, content, sources, chartData, newsResults, saveToHistory, sentiment, imageData) {
    if (saveToHistory === undefined) saveToHistory = false;
    var messageDiv = document.createElement('div');
    messageDiv.className = 'message ' + type + '-message';
    var avatarHtml = type === 'user' ? '<i class="fas fa-user"></i>' : '<img src="' + LOGO_URL + '" alt="University Logo">';
    var time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    
    var sentimentHtml = '';
    if (type === 'bot' && sentiment && sentiment !== 'neutral') {
        var sentimentEmoji = '';
        var sentimentText = '';
        if (sentiment === 'positive') { sentimentEmoji = '😊'; sentimentText = 'Happy'; }
        else if (sentiment === 'negative') { sentimentEmoji = '😟'; sentimentText = 'Sad'; }
        else if (sentiment === 'frustrated') { sentimentEmoji = '🤯'; sentimentText = 'Frustrated'; }
        sentimentHtml = `<span class="sentiment-badge sentiment-${sentiment}" title="Mood: ${sentimentText}">${sentimentEmoji} ${sentimentText}</span>`;
    }

    var actionButtonsHtml = type === 'bot' ? `
        <div style="display: flex; gap: 4px; align-items: center;">
            ${sentimentHtml}
            <button class="speak-btn" onclick="toggleSpeak(this)" title="Read Aloud"><i class="fas fa-volume-up"></i></button>
            <button class="copy-msg-btn" onclick="copyMessageText(this)" title="Copy"><i class="far fa-copy"></i></button>
        </div>` : '';

    var extrasHtml = '';
    if (sources && sources.length > 0) {
        extrasHtml += '<div class="message-sources"><i class="fas fa-file-alt"></i> Based on: ' + sources.slice(0, 2).join(', ') + '</div>';
    }

    var imageHtml = '';
    if (imageData) {
        imageHtml = `<div class="message-image-wrapper" style="margin-bottom:8px; border-radius:8px; overflow:hidden; max-width:200px; border: 1px solid var(--border);"><img src="${imageData}" style="width:100%; height:auto; display:block; cursor:pointer;" onclick="window.open(this.src)"></div>`;
    }

    messageDiv.innerHTML = `
        <div class="message-avatar">${avatarHtml}</div>
        <div class="message-bubble">
            ${imageHtml}
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
    
    if (type === 'bot') {
        renderChartIfPresent(messageDiv, content);
    }

    scrollToBottom();
    if (saveToHistory) saveMessageToHistory(type === 'bot' ? 'assistant' : 'user', content, sources, chartData, newsResults, sentiment, imageData);
}

function formatMessage(text) {
    if (!text) return "";
    
    // Remove chart tag from rendering
    var cleanText = text.replace(/\[CHART:\s*\{[\s\S]*?\}\s*\]/g, '');

    var escaped = cleanText.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    var codeBlocks = [];
    escaped = escaped.replace(/```(\w*)\n([\s\S]*?)```/g, function (match, lang, code) {
        var placeholder = '__CODE_BLOCK_PLACEHOLDER_' + codeBlocks.length + '__';
        codeBlocks.push({ lang: lang || 'code', code: code.trim() });
        return placeholder;
    });

    escaped = escaped.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');
    escaped = escaped.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

    // Headers support (replace early before breaking lines)
    escaped = escaped.replace(/^###\s+(.*)$/gim, '<h3>$1</h3>');
    escaped = escaped.replace(/^##\s+(.*)$/gim, '<h2>$1</h2>');
    escaped = escaped.replace(/^#\s+(.*)$/gim, '<h1>$1</h1>');

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
        var cleanContent = msg.content.replace(/\[CHART:\s*\{[\s\S]*?\}\s*\]/g, '[Interactive Chart]');
        text += (msg.role === 'assistant' ? '🤖 AI' : '👤 You') + ':\n' + cleanContent + '\n\n--------------------------------------------------\n\n';
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
    var tabMap = { 
        'chat': 'tabBtnChat', 
        'flashcards': 'tabBtnFlashcards', 
        'studyplan': 'tabBtnStudyPlan', 
        'pastpapers': 'tabBtnPastPapers',
        'summaries': 'tabBtnSummaries',
        'quiz': 'tabBtnQuiz',
        'stats': 'tabBtnStats'
    };
    if (tabMap[tabName]) document.getElementById(tabMap[tabName]).classList.add('active');
    document.querySelectorAll('.tab-section').forEach(function (s) { s.classList.remove('active'); s.style.display = 'none'; });
    var secMap = { 
        'chat': 'chatSection', 
        'flashcards': 'flashcardsSection', 
        'studyplan': 'studyplanSection', 
        'pastpapers': 'pastpapersSection',
        'summaries': 'summariesSection',
        'quiz': 'quizSection',
        'stats': 'statsSection'
    };
    var sec = document.getElementById(secMap[tabName]);
    if (sec) { sec.classList.add('active'); sec.style.display = 'flex'; }
    if (tabName === 'chat') userInput.focus();
    else if (tabName === 'flashcards') document.getElementById('flashcardTopic').focus();
    else if (tabName === 'pastpapers') { loadTopicRankings(); loadPastPapersList(); }
    else if (tabName === 'summaries') document.getElementById('summaryTopic').focus();
    else if (tabName === 'quiz') document.getElementById('quizTopic').focus();
    else if (tabName === 'stats') { renderStatsDashboard(); }
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
    incrementStat('cardsReviewed');
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
    if (typeof rawText === 'object' && rawText !== null) return rawText;
    var cleanText = rawText.trim();
    try { return JSON.parse(cleanText); } catch (e) { }
    var match = cleanText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (match) { try { return JSON.parse(match[1].trim()); } catch (e) { } }
    cleanText = cleanText.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    var startIdx = cleanText.indexOf('{'); var endIdx = cleanText.lastIndexOf('}');
    if (startIdx >= 0 && endIdx > startIdx) { try { return JSON.parse(cleanText.substring(startIdx, endIdx + 1)); } catch (e) { } }
    return null;
}

function formatAnyValue(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value.replace(/\n/g, '<br>');
    if (Array.isArray(value)) { return value.map(function (v) { if (typeof v === 'object' && v !== null) return JSON.stringify(v); return '• ' + v; }).join('<br>'); }
    if (typeof value === 'object') { var html = ''; for (var key in value) { if (value.hasOwnProperty(key)) { html += '<strong>' + key + ':</strong> ' + (typeof value[key] === 'string' ? value[key] : formatAnyValue(value[key])) + '<br>'; } } return html; }
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
    btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Generating Plan...'; resultDiv.style.display = 'none';
    try {
        var response = await fetch('/generate-study-plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ exam_date: examDate, subjects: subjects, hours_per_day: parseInt(hoursPerDay) }) });
        var data = await response.json();
        if (data.success && data.study_plan) {
            var plan = data.study_plan;
            if (typeof plan.overview === 'string') {
                var overviewTrimmed = plan.overview.trim();
                if (overviewTrimmed.startsWith('{') || overviewTrimmed.startsWith('```')) {
                    var parsed = parseStudyPlanJSON(overviewTrimmed);
                    if (parsed && parsed.overview && !parsed.overview.startsWith('{')) {
                        plan.overview = parsed.overview;
                        if (parsed.subjects_breakdown) plan.subjects_breakdown = parsed.subjects_breakdown;
                        if (parsed.weekly_plan) plan.weekly_plan = parsed.weekly_plan;
                        if (parsed.daily_schedule) plan.daily_schedule = parsed.daily_schedule;
                        if (parsed.revision_strategy) plan.revision_strategy = parsed.revision_strategy;
                        if (parsed.exam_day_tips) plan.exam_day_tips = parsed.exam_day_tips;
                    }
                }
                plan.overview = plan.overview.replace(/```json[\s\S]*?```/g, '').replace(/```[\s\S]*?```/g, '').trim();
                var jsonStart = plan.overview.indexOf('{"');
                if (jsonStart > 0) plan.overview = plan.overview.substring(0, jsonStart).trim();
                if (plan.overview.startsWith('{')) plan.overview = 'Your personalized study plan is ready!';
            }
            renderStudyPlan(plan); 
            incrementStat('plansCreated');
            resultDiv.style.display = 'block'; 
            resultDiv.scrollIntoView({ behavior: 'smooth' }); 
            showToast('✅ Study plan generated!');
        } else { showToast(data.error || 'Failed to generate plan'); }
    } catch (error) { console.error('Study plan error:', error); showToast('Connection error. Please try again.'); }
    finally { btn.disabled = false; btn.innerHTML = '<i class="fas fa-magic"></i> Generate Study Plan'; }
}

function renderStudyPlan(plan) {
    if (plan.raw_response) {
        var overviewDiv = document.getElementById('planOverview');
        var cleanOverview = (plan.overview || 'Your personalized study plan is ready!').replace(/```json[\s\S]*?```/g, '').replace(/```[\s\S]*?```/g, '');
        if (cleanOverview.startsWith('{')) cleanOverview = 'Your personalized study plan has been generated!';
        overviewDiv.innerHTML = '<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;"><i class="fas fa-lightbulb" style="font-size:20px;color:#f59e0b;"></i><span style="font-weight:700;color:var(--text);font-size:16px;">Study Plan Overview</span></div><p style="color:var(--text-secondary);line-height:1.7;font-size:14px;">' + cleanOverview + '</p><div style="display:flex;gap:20px;margin-top:12px;flex-wrap:wrap;"><span style="background:white;padding:8px 16px;border-radius:20px;font-size:13px;font-weight:600;color:var(--primary);">📅 ' + (plan.days_until_exam || 0) + ' days</span><span style="background:white;padding:8px 16px;border-radius:20px;font-size:13px;font-weight:600;color:var(--success);">⏰ ' + (plan.total_study_hours || 0) + ' hours</span></div>';
        document.getElementById('planSubjects').innerHTML = ''; document.getElementById('planWeekly').innerHTML = '';
        document.getElementById('planDaily').innerHTML = ''; document.getElementById('planTips').innerHTML = '';
        return;
    }
    var overviewDiv = document.getElementById('planOverview');
    var overviewText = (plan.overview || 'Your personalized study plan is ready!').replace(/```json[\s\S]*?```/g, '').replace(/```[\s\S]*?```/g, '');
    if (overviewText.startsWith('{')) overviewText = 'Your personalized study plan is ready!';
    overviewDiv.innerHTML = '<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;"><i class="fas fa-lightbulb" style="font-size:20px;color:#f59e0b;"></i><span style="font-weight:700;color:var(--text);font-size:16px;">Study Plan Overview</span></div><p style="color:var(--text-secondary);line-height:1.7;font-size:14px;">' + overviewText + '</p><div style="display:flex;gap:20px;margin-top:12px;flex-wrap:wrap;"><span style="background:white;padding:8px 16px;border-radius:20px;font-size:13px;font-weight:600;color:var(--primary);">📅 ' + (plan.days_until_exam || 0) + ' days</span><span style="background:white;padding:8px 16px;border-radius:20px;font-size:13px;font-weight:600;color:var(--success);">⏰ ' + (plan.total_study_hours || 0) + ' hours</span></div>';

    var subjectsDiv = document.getElementById('planSubjects');
    if (plan.subjects_breakdown && plan.subjects_breakdown.length > 0) {
        var subjectsHTML = '<h4 style="margin-bottom:12px;color:var(--text);font-size:15px;">📚 Subject Breakdown</h4>';
        subjectsHTML += plan.subjects_breakdown.map(function (s) {
            var priorityColor = 'background:#dbeafe;color:#2563eb;';
            if (s.priority === 'High') priorityColor = 'background:#fee2e2;color:#dc2626;';
            else if (s.priority === 'Medium') priorityColor = 'background:#fef3c7;color:#d97706;';
            var topicsHTML = '';
            if (s.topics && s.topics.length > 0) { topicsHTML = '<div style="margin-top:8px;"><span style="font-size:12px;font-weight:600;color:var(--text);">📝 Key Topics:</span><div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:4px;">' + s.topics.map(function (t) { return '<span style="background:var(--surface-light);padding:4px 10px;border-radius:15px;font-size:11px;color:var(--text-secondary);">' + t + '</span>'; }).join('') + '</div></div>'; }
            var tipsText = s.tips ? (Array.isArray(s.tips) ? s.tips.join('; ') : String(s.tips)) : '';
            return '<div style="background:var(--surface);border:1.5px solid #dbeafe;border-radius:12px;padding:18px;margin-bottom:12px;"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;"><span style="font-weight:700;color:var(--text);font-size:15px;">' + (s.subject || 'Subject') + '</span><span style="padding:5px 12px;border-radius:20px;font-size:11px;font-weight:700;' + priorityColor + '">' + (s.priority || 'Medium') + ' Priority</span></div><p style="font-size:13px;color:var(--text-secondary);margin-bottom:6px;">⏱️ <strong>' + (s.total_hours || 0) + ' hours</strong></p>' + topicsHTML + (tipsText ? '<p style="font-size:12px;color:var(--primary);margin-top:8px;padding:8px;background:rgba(29,78,216,0.05);border-radius:8px;">💡 <strong>Tip:</strong> ' + tipsText + '</p>' : '') + '</div>';
        }).join('');
        subjectsDiv.innerHTML = subjectsHTML;
    } else { subjectsDiv.innerHTML = '<p style="color:var(--text-secondary);font-size:13px;">No subject breakdown available.</p>'; }

    var weeklyDiv = document.getElementById('planWeekly');
    if (plan.weekly_plan && plan.weekly_plan.length > 0) {
        var relevantWeeks = plan.weekly_plan.filter(function (w) { return w.week <= Math.ceil((plan.days_until_exam || 30) / 7) + 2; });
        if (relevantWeeks.length > 0) {
            var weeklyHTML = '<h4 style="margin-bottom:14px;color:var(--text);font-size:15px;">📅 Weekly Schedule</h4>';
            weeklyHTML += relevantWeeks.map(function (w, i) {
                var tasksHTML = '';
                if (w.tasks && w.tasks.length > 0) { tasksHTML = '<div style="display:grid;gap:6px;margin-top:8px;">' + w.tasks.map(function (t) { if (typeof t === 'object' && t.day) { return '<div style="display:flex;gap:10px;padding:8px 12px;background:var(--surface-light);border-radius:8px;"><span style="font-weight:600;color:var(--primary);font-size:12px;min-width:50px;">Day ' + t.day + '</span><span style="font-size:12px;color:var(--text-secondary);">' + (t.task || '') + '</span></div>'; } return '<div style="padding:8px 12px;background:var(--surface-light);border-radius:8px;font-size:12px;color:var(--text-secondary);"><i class="fas fa-check-circle" style="color:var(--success);margin-right:6px;"></i>' + t + '</div>'; }).join('') + '</div>'; }
                return '<div style="padding:12px 0;border-bottom:1px solid #dbeafe;"><div style="font-weight:700;color:var(--primary);font-size:14px;margin-bottom:6px;">Week ' + (w.week || (i + 1)) + ': ' + (w.focus || 'Study Focus') + '</div>' + tasksHTML + '</div>';
            }).join('');
            weeklyDiv.innerHTML = weeklyHTML;
        } else { weeklyDiv.innerHTML = '<p style="color:var(--text-secondary);font-size:13px;">Weekly schedule not available.</p>'; }
    } else { weeklyDiv.innerHTML = '<p style="color:var(--text-secondary);font-size:13px;">No weekly plan available.</p>'; }

    var dailyDiv = document.getElementById('planDaily');
    if (plan.daily_schedule) { dailyDiv.innerHTML = '<h4 style="margin-bottom:12px;color:var(--text);font-size:15px;">📋 Daily Study Schedule</h4><div style="background:var(--surface-light);border-radius:12px;padding:18px;font-size:14px;color:var(--text-secondary);line-height:2;">' + formatAnyValue(plan.daily_schedule) + '</div>'; }
    else { dailyDiv.innerHTML = ''; }

    var tipsDiv = document.getElementById('planTips');
    var tipsHTML = '';
    if (plan.revision_strategy) { tipsHTML += '<div style="background:linear-gradient(135deg,#f0fdf4,#dcfce7);border:1.5px solid #bbf7d0;border-radius:12px;padding:18px;margin-bottom:12px;"><h4 style="color:#059669;margin-bottom:10px;font-size:14px;"><i class="fas fa-sync-alt"></i> Revision Strategy</h4><p style="font-size:13px;color:var(--text-secondary);line-height:1.7;">' + formatAnyValue(plan.revision_strategy) + '</p></div>'; }
    if (plan.exam_day_tips) { tipsHTML += '<div style="background:linear-gradient(135deg,#fef3c7,#fde68a);border:1.5px solid #fcd34d;border-radius:12px;padding:18px;"><h4 style="color:#d97706;margin-bottom:10px;font-size:14px;"><i class="fas fa-star"></i> Exam Day Tips</h4><p style="font-size:13px;color:var(--text-secondary);line-height:1.7;">' + formatAnyValue(plan.exam_day_tips) + '</p></div>'; }
    tipsDiv.innerHTML = tipsHTML || '<p style="color:var(--text-secondary);font-size:13px;">No tips available.</p>';
}

// ========== PAST PAPER INTELLIGENCE ==========

async function loadTopicRankings() {
    var btn = document.getElementById('refreshRankingsBtn');
    var listDiv = document.getElementById('topicRankingsList');
    if (!btn || !listDiv) return;
    btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Loading...';
    try {
        var response = await fetch('/api/past-papers/rankings');
        var data = await response.json();
        if (data.success && data.rankings && data.rankings.topic_rankings && data.rankings.topic_rankings.length > 0) {
            var rankings = data.rankings;
            var html = '<div style="background:var(--surface-light);border-radius:12px;padding:16px;margin-bottom:12px;"><p style="font-size:13px;color:var(--text-secondary);">📊 <strong>' + rankings.total_papers_analyzed + '</strong> papers analyzed | <strong>' + rankings.total_questions_found + '</strong> questions found</p></div>';
            html += rankings.topic_rankings.map(function (topic, index) {
                var badgeColor = topic.importance === 'High' ? 'background:#fee2e2;color:#dc2626;' : topic.importance === 'Medium' ? 'background:#fef3c7;color:#d97706;' : 'background:#dbeafe;color:#2563eb;';
                var medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : '';
                return '<div style="background:var(--surface);border:1.5px solid #dbeafe;border-radius:12px;padding:16px;display:flex;justify-content:space-between;align-items:center;"><div style="flex:1;"><div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;"><span style="font-size:18px;">' + medal + '</span><span style="font-weight:700;color:var(--text);font-size:15px;">' + topic.topic + '</span><span style="padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700;' + badgeColor + '">' + topic.importance + '</span></div><p style="font-size:12px;color:var(--text-secondary);">📝 Appeared in <strong>' + topic.appearances + '</strong> papers | 🔑 Keywords: ' + topic.keywords.slice(0, 5).join(', ') + (topic.years && topic.years.length > 0 ? ' | 📅 Years: ' + topic.years.join(', ') : '') + '</p></div><div style="text-align:center;min-width:60px;"><div style="font-size:24px;font-weight:800;color:var(--primary);">' + topic.total_frequency + '</div><div style="font-size:10px;color:var(--text-secondary);">mentions</div></div></div>';
            }).join('');
            listDiv.innerHTML = html;
        } else { listDiv.innerHTML = '<p style="color:var(--text-secondary);text-align:center;padding:40px;">No topics found. Upload past papers from the admin panel to see rankings.</p>'; }
    } catch (error) { console.error('Error loading rankings:', error); listDiv.innerHTML = '<p style="color:var(--error);text-align:center;padding:40px;">Error loading rankings. Please try again.</p>'; }
    finally { btn.disabled = false; btn.innerHTML = '<i class="fas fa-sync-alt"></i> Refresh'; }
}

async function searchPastPapers() {
    var query = document.getElementById('pastPaperSearch').value.trim();
    if (!query) { showToast('Please enter a search query'); return; }
    var btn = document.getElementById('searchPastPaperBtn');
    var resultsDiv = document.getElementById('pastPaperSearchResults');
    var resultsContent = document.getElementById('searchResultsContent');
    btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Searching...';
    resultsDiv.style.display = 'block'; resultsContent.innerHTML = '<p style="text-align:center;padding:20px;"><i class="fas fa-spinner fa-spin"></i> Searching past papers...</p>';
    try {
        var response = await fetch('/api/past-papers/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: query }) });
        var data = await response.json();
        if (data.success) {
            var html = '';
            if (data.related_topics && data.related_topics.length > 0) {
                html += '<h4 style="color:var(--text);font-size:14px;margin-bottom:12px;">📊 Related Topics</h4><div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:20px;">';
                data.related_topics.forEach(function (topic) {
                    var badgeColor = topic.importance === 'High' ? 'background:#fee2e2;color:#dc2626;' : topic.importance === 'Medium' ? 'background:#fef3c7;color:#d97706;' : 'background:#dbeafe;color:#2563eb;';
                    html += '<span style="padding:6px 14px;border-radius:20px;font-size:12px;font-weight:600;' + badgeColor + '">' + topic.topic + ' (' + topic.frequency + '×)</span>';
                });
                html += '</div>';
            }
            if (data.related_questions && data.related_questions.length > 0) {
                html += '<h4 style="color:var(--text);font-size:14px;margin-bottom:12px;">❓ Related Questions</h4>';
                html += data.related_questions.map(function (q) { return '<div style="background:var(--surface);border:1.5px solid #dbeafe;border-radius:10px;padding:14px;margin-bottom:8px;"><p style="font-size:13px;color:var(--text);margin-bottom:6px;">' + q.question + '</p><span style="font-size:11px;color:var(--text-secondary);">📄 ' + q.paper + ' (' + q.year + ')</span></div>'; }).join('');
            }
            if (!html) html = '<p style="color:var(--text-secondary);text-align:center;padding:40px;">No results found for "' + query + '".</p>';
            resultsContent.innerHTML = html;
        } else { resultsContent.innerHTML = '<p style="color:var(--error);text-align:center;padding:20px;">Search failed. Please try again.</p>'; }
    } catch (error) { console.error('Search error:', error); resultsContent.innerHTML = '<p style="color:var(--error);text-align:center;padding:20px;">Error searching. Please try again.</p>'; }
    finally { btn.disabled = false; btn.innerHTML = '<i class="fas fa-search"></i> Search'; }
}

async function loadPastPapersList() {
    try {
        var response = await fetch('/api/past-papers/list');
        var data = await response.json();
        if (data.success && data.papers && data.papers.length > 0) {
            var html = data.papers.map(function (paper) {
                return '<div style="background:var(--surface);border:1.5px solid #dbeafe;border-radius:10px;padding:14px;display:flex;justify-content:space-between;align-items:center;"><div><p style="font-weight:600;color:var(--text);font-size:14px;">📄 ' + paper.filename + '</p><p style="font-size:12px;color:var(--text-secondary);">📅 ' + paper.year + ' | 📝 ' + paper.questions_count + ' questions | 🏷️ ' + paper.topics_count + ' topics</p></div><span style="font-size:11px;color:var(--text-secondary);">Analyzed: ' + new Date(paper.analyzed_at).toLocaleDateString() + '</span></div>';
            }).join('');
            document.getElementById('pastPapersList').innerHTML = html;
        }
    } catch (error) { console.error('Error loading papers list:', error); }
}

// ========== CHAPTER SUMMARIES ==========
var isGeneratingSummary = false;

async function generateSummary() {
    if (isGeneratingSummary) return;
    var topic = document.getElementById('summaryTopic').value.trim();
    if (!topic) {
        showToast('Please enter a chapter topic or title');
        return;
    }
    
    var btn = document.getElementById('generateSummaryBtn');
    var resultDiv = document.getElementById('summaryResult');
    var resultContent = document.getElementById('summaryResultContent');
    
    isGeneratingSummary = true;
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Generating Summary...';
    resultDiv.style.display = 'block';
    resultContent.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-secondary);"><i class="fas fa-spinner fa-spin" style="font-size:24px;margin-bottom:10px;display:block;"></i>Analyzing documents and writing summary...</div>';
    
    try {
        var res = await fetch('/generate-summary', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ topic: topic })
        });
        var data = await res.json();
        if (data.success && data.summary) {
            resultContent.innerHTML = formatMessage(data.summary);
            resultDiv.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        } else {
            resultContent.innerHTML = '<div style="color:#ef4444;text-align:center;padding:20px;"><i class="fas fa-exclamation-circle"></i> ' + (data.error || 'Failed to generate summary.') + '</div>';
        }
    } catch (e) {
        resultContent.innerHTML = '<div style="color:#ef4444;text-align:center;padding:20px;"><i class="fas fa-exclamation-circle"></i> Connection error. Please try again.</div>';
    } finally {
        isGeneratingSummary = false;
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-magic"></i> Generate Summary';
    }
}

function copySummaryText() {
    var contentDiv = document.getElementById('summaryResultContent');
    if (!contentDiv) return;
    var text = contentDiv.textContent || contentDiv.innerText;
    if (!text || text.includes('Analyzing documents') || text.includes('Connection error')) {
        showToast('No summary content to copy');
        return;
    }
    navigator.clipboard.writeText(text).then(function() {
        showToast('Summary copied to clipboard!');
    }).catch(function() {
        showToast('Failed to copy');
    });
}

// ========== IMAGE UPLOAD SUPPORT ==========
var selectedImageData = null;
var selectedImageMime = null;

function triggerImageUpload(e) {
    if (e) e.preventDefault();
    var fileInput = document.getElementById('imageInput');
    if (fileInput) fileInput.click();
}

function handleImageSelection(e) {
    var file = e.target.files[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
        showToast('Please select a valid image file');
        return;
    }
    
    var reader = new FileReader();
    reader.onload = function(event) {
        var base64 = event.target.result;
        selectedImageData = base64.split(',')[1];
        selectedImageMime = file.type;
        
        var previewContainer = document.getElementById('imagePreviewContainer');
        var thumbnail = document.getElementById('imagePreviewThumbnail');
        var nameLabel = document.getElementById('imagePreviewName');
        
        if (previewContainer && thumbnail && nameLabel) {
            thumbnail.src = base64;
            nameLabel.textContent = file.name;
            previewContainer.style.display = 'flex';
        }
    };
    reader.readAsDataURL(file);
}

function clearSelectedImage(e) {
    if (e) e.preventDefault();
    selectedImageData = null;
    selectedImageMime = null;
    
    var previewContainer = document.getElementById('imagePreviewContainer');
    var fileInput = document.getElementById('imageInput');
    if (previewContainer) previewContainer.style.display = 'none';
    if (fileInput) fileInput.value = '';
}

// ========== STUDENT STATISTICS & DASHBOARD ==========
var studentStats = {
    questionsAsked: 0,
    cardsReviewed: 0,
    plansCreated: 0,
    quizzesCompleted: 0,
    totalQuizScore: 0
};

function loadStats() {
    var saved = localStorage.getItem('university_student_stats');
    if (saved) {
        try {
            studentStats = JSON.parse(saved);
        } catch (e) {
            console.error('Failed to parse stats:', e);
        }
    }
}

function saveStats() {
    localStorage.setItem('university_student_stats', JSON.stringify(studentStats));
}

function incrementStat(key, val) {
    if (val === undefined) val = 1;
    if (studentStats[key] !== undefined) {
        studentStats[key] += val;
        saveStats();
    }
}

function renderStatsDashboard() {
    loadStats();
    
    document.getElementById('statQuestions').textContent = studentStats.questionsAsked || 0;
    document.getElementById('statFlashcards').textContent = studentStats.cardsReviewed || 0;
    document.getElementById('statPlans').textContent = studentStats.plansCreated || 0;
    document.getElementById('statQuizzes').textContent = studentStats.quizzesCompleted || 0;
    
    var scoreText = '0%';
    var barWidth = '0%';
    if (studentStats.quizzesCompleted > 0) {
        var totalQuestions = studentStats.quizzesCompleted * 5;
        var percentage = Math.round((studentStats.totalQuizScore / totalQuestions) * 100);
        scoreText = percentage + '%';
        barWidth = percentage + '%';
    }
    
    document.getElementById('quizAccuracyPercent').textContent = scoreText;
    document.getElementById('quizAccuracyBar').style.width = barWidth;
}


// ========== AI PRACTICE QUIZ CONTROLLER ==========
var activeQuizDeck = [];
var currentQuizIndex = 0;
var quizSelectedAnswer = null;
var activeQuizScore = 0;
var isGeneratingQuiz = false;

async function generateQuiz() {
    if (isGeneratingQuiz) return;
    var topic = document.getElementById('quizTopic').value.trim();
    if (!topic) {
        showToast('Please enter a quiz topic');
        return;
    }
    
    var btn = document.getElementById('generateQuizBtn');
    isGeneratingQuiz = true;
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Generating Quiz...';
    
    try {
        var res = await fetch('/generate-quiz', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ topic: topic })
        });
        var data = await res.json();
        if (data.success && data.quiz && data.quiz.length > 0) {
            activeQuizDeck = data.quiz;
            currentQuizIndex = 0;
            activeQuizScore = 0;
            
            document.getElementById('quizSetupForm').style.display = 'none';
            document.getElementById('quizPlayContainer').style.display = 'block';
            document.getElementById('quizScorecard').style.display = 'none';
            
            showToast('Quiz generated! Good luck!');
            renderQuizQuestion();
        } else {
            showToast(data.error || 'Failed to generate quiz.');
        }
    } catch (e) {
        showToast('Connection error. Please try again.');
    } finally {
        isGeneratingQuiz = false;
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-play"></i> Generate Quiz';
    }
}

function renderQuizQuestion() {
    if (!activeQuizDeck.length || currentQuizIndex >= activeQuizDeck.length) return;
    
    var q = activeQuizDeck[currentQuizIndex];
    quizSelectedAnswer = null;
    
    document.getElementById('quizProgressLabel').textContent = 'Question ' + (currentQuizIndex + 1) + ' of ' + activeQuizDeck.length;
    document.getElementById('quizQuestionText').textContent = q.question;
    
    document.getElementById('quizExplanationBox').style.display = 'none';
    var actionBtn = document.getElementById('quizActionBtn');
    actionBtn.innerHTML = '<i class="fas fa-check"></i> Submit Answer';
    actionBtn.onclick = submitQuizAnswer;
    
    var optionsList = document.getElementById('quizOptionsList');
    optionsList.innerHTML = '';
    
    q.options.forEach(function(opt, index) {
        var optBtn = document.createElement('div');
        optBtn.className = 'quiz-option';
        optBtn.style.cssText = 'padding:14px; background:var(--surface-light); border:1.5px solid var(--border); border-radius:10px; cursor:pointer; font-size:14px; transition:all 0.2s; color:var(--text);';
        optBtn.innerHTML = opt;
        
        optBtn.onclick = function() {
            document.querySelectorAll('.quiz-option').forEach(function(el) {
                el.style.borderColor = 'var(--border)';
                el.style.background = 'var(--surface-light)';
            });
            
            optBtn.style.borderColor = 'var(--primary)';
            optBtn.style.background = 'var(--surface-warm)';
            quizSelectedAnswer = index;
        };
        
        optionsList.appendChild(optBtn);
    });
}

function submitQuizAnswer() {
    if (quizSelectedAnswer === null) {
        showToast('Please select an option first!');
        return;
    }
    
    var q = activeQuizDeck[currentQuizIndex];
    var optionElements = document.querySelectorAll('.quiz-option');
    
    optionElements.forEach(function(el, index) {
        el.onclick = null;
        if (index === q.answer_index) {
            el.style.borderColor = 'var(--success)';
            el.style.background = '#d1fae5';
            el.style.color = '#047857';
            el.innerHTML += ' <i class="fas fa-check-circle" style="color:var(--success); margin-left:8px;"></i>';
        } else if (index === quizSelectedAnswer) {
            el.style.borderColor = 'var(--error)';
            el.style.background = '#ffe4e6';
            el.style.color = '#b91c1c';
            el.innerHTML += ' <i class="fas fa-times-circle" style="color:var(--error); margin-left:8px;"></i>';
        }
    });
    
    var isCorrect = (quizSelectedAnswer === q.answer_index);
    if (isCorrect) {
        activeQuizScore++;
        showToast('Correct answer! 🎉');
    } else {
        showToast('Incorrect answer 😢');
    }
    
    var explBox = document.getElementById('quizExplanationBox');
    explBox.innerHTML = '<strong>Explanation:</strong> ' + q.explanation;
    explBox.style.display = 'block';
    
    var actionBtn = document.getElementById('quizActionBtn');
    if (currentQuizIndex < activeQuizDeck.length - 1) {
        actionBtn.innerHTML = 'Next Question <i class="fas fa-arrow-right"></i>';
        actionBtn.onclick = nextQuizQuestion;
    } else {
        actionBtn.innerHTML = 'View Scorecard <i class="fas fa-trophy"></i>';
        actionBtn.onclick = showQuizResults;
    }
}

function nextQuizQuestion() {
    currentQuizIndex++;
    renderQuizQuestion();
}

function showQuizResults() {
    incrementStat('quizzesCompleted', 1);
    incrementStat('totalQuizScore', activeQuizScore);
    
    document.getElementById('quizPlayContainer').style.display = 'none';
    document.getElementById('quizScorecard').style.display = 'block';
    document.getElementById('quizScoreText').textContent = activeQuizScore + ' / ' + activeQuizDeck.length;
}

function restartQuiz() {
    document.getElementById('quizScorecard').style.display = 'none';
    document.getElementById('quizSetupForm').style.display = 'block';
    document.getElementById('quizTopic').value = '';
}