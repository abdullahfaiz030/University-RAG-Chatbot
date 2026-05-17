const chatMessages = document.getElementById('chatMessages');
const userInput = document.getElementById('userInput');
const sendBtn = document.getElementById('sendBtn');
const docStatus = document.getElementById('docStatus');
const voiceBtn = document.getElementById('voiceBtn');
const voiceStatus = document.getElementById('voiceStatus');
const languageSelect = document.getElementById('languageSelect');

let isProcessing = false;
let isListening = false;
let selectedLanguage = 'en';
let recognition = null;

// Initialize
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
            const transcript = event.results[0][0].transcript;
            userInput.value = transcript;
        };
        
        recognition.onend = () => {
            stopListening();
        };
        
        recognition.onerror = () => {
            stopListening();
        };
    } else {
        voiceBtn.style.display = 'none';
        voiceStatus.textContent = 'Voice not supported';
    }
}

function toggleVoiceInput() {
    if (isListening) {
        stopListening();
    } else {
        startListening();
    }
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
    
    // Add user message
    addMessage('user', message);
    userInput.value = '';
    userInput.style.height = 'auto';
    
    // Show typing indicator
    const typingId = showTypingIndicator();
    sendBtn.disabled = true;
    
    try {
        const response = await fetch('/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                message: message,
                language: selectedLanguage 
            })
        });
        
        const data = await response.json();
        removeTypingIndicator(typingId);
        
        if (data.response) {
            addMessage('bot', data.response, data.sources, data.chart_data, data.news_results);
        } else {
            addMessage('bot', 'Sorry, I encountered an error. Please try again.');
        }
    } catch (error) {
        removeTypingIndicator(typingId);
        addMessage('bot', '⚠️ Connection error. Please check your internet and try again.');
    } finally {
        sendBtn.disabled = false;
        isProcessing = false;
        userInput.focus();
    }
}

function addMessage(type, content, sources = null, chartData = null, newsResults = null) {
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${type}-message`;
    
    const avatarIcon = type === 'user' ? 'fa-user' : 'fa-robot';
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    
    let extrasHtml = '';
    
    // Sources
    if (sources && sources.length > 0) {
        extrasHtml += `
            <div class="message-sources">
                <i class="fas fa-file-alt"></i>
                Based on: ${sources.slice(0, 2).join(', ')}
            </div>
        `;
    }
    
    // Chart
    if (chartData) {
        extrasHtml += `
            <div class="chart-container">
                <canvas id="chart-${Date.now()}"></canvas>
            </div>
        `;
    }
    
    // News
    if (newsResults && newsResults.length > 0) {
        newsResults.forEach(news => {
            extrasHtml += `
                <div class="news-card">
                    <div class="news-title">📰 ${news.title}</div>
                    <div class="news-snippet">${news.snippet}</div>
                    <div class="news-source">Source: ${news.source || 'Web'}</div>
                </div>
            `;
        });
    }
    
    const formattedContent = formatMessage(content);
    
    messageDiv.innerHTML = `
        <div class="message-avatar">
            <i class="fas ${avatarIcon}"></i>
        </div>
        <div class="message-bubble">
            <div class="message-text">${formattedContent}</div>
            <div class="message-time">${time}</div>
            ${extrasHtml}
        </div>
    `;
    
    // Remove welcome message if exists
    const welcomeMsg = chatMessages.querySelector('.welcome-message');
    if (welcomeMsg) {
        welcomeMsg.style.animation = 'fadeOut 0.3s ease forwards';
        setTimeout(() => welcomeMsg.remove(), 300);
    }
    
    chatMessages.appendChild(messageDiv);
    scrollToBottom();
    
    // Render chart if present
    if (chartData) {
        setTimeout(() => renderChart(messageDiv.querySelector('canvas'), chartData), 100);
    }
}

function renderChart(canvas, chartData) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    
    // Simple bar chart using Canvas API (no library needed)
    const data = chartData;
    const labels = Object.keys(data);
    const values = Object.values(data);
    const maxVal = Math.max(...values);
    
    const width = canvas.parentElement.clientWidth - 30;
    const height = 250;
    canvas.width = width;
    canvas.height = height;
    
    const barWidth = width / labels.length - 10;
    const colors = ['#6366f1', '#06b6d4', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6'];
    
    // Draw bars
    values.forEach((val, i) => {
        const barHeight = (val / maxVal) * (height - 40);
        const x = i * (barWidth + 10) + 10;
        const y = height - barHeight - 20;
        
        ctx.fillStyle = colors[i % colors.length];
        ctx.fillRect(x, y, barWidth, barHeight);
        
        // Label
        ctx.fillStyle = '#94a3b8';
        ctx.font = '10px Inter';
        ctx.textAlign = 'center';
        ctx.fillText(labels[i].substring(0, 10), x + barWidth / 2, height - 5);
        
        // Value
        ctx.fillStyle = '#f1f5f9';
        ctx.font = '11px Inter';
        ctx.fillText(val, x + barWidth / 2, y - 5);
    });
}

function formatMessage(text) {
    text = text.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" style="color: #818cf8;">$1</a>');
    text = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/\n/g, '<br>');
    return text;
}

function showTypingIndicator() {
    const id = 'typing-' + Date.now();
    const typingDiv = document.createElement('div');
    typingDiv.className = 'message bot-message';
    typingDiv.id = id;
    typingDiv.innerHTML = `
        <div class="message-avatar">
            <i class="fas fa-robot"></i>
        </div>
        <div class="message-bubble">
            <div class="typing-indicator">
                <span></span><span></span><span></span>
            </div>
        </div>
    `;
    
    chatMessages.appendChild(typingDiv);
    scrollToBottom();
    return id;
}

function removeTypingIndicator(id) {
    const element = document.getElementById(id);
    if (element) {
        element.style.animation = 'fadeOut 0.2s ease forwards';
        setTimeout(() => element.remove(), 200);
    }
}

function handleKeyDown(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendMessage();
    }
}

function startNewChat() {
    chatMessages.innerHTML = `
        <div class="welcome-message">
            <div class="welcome-icon">
                <i class="fas fa-graduation-cap"></i>
            </div>
            <h3>Welcome to Your AI Study Assistant! 👋</h3>
            <p>I'm here to help you understand your course materials. Ask me anything about your lecture notes, and I'll give you clear, simple answers.</p>
            <div class="suggestion-chips">
                <button onclick="sendSuggestion('What is a project?')" class="chip">
                    <i class="fas fa-bullseye"></i> What is a project?
                </button>
                <button onclick="sendSuggestion('Explain the factors affecting software development')" class="chip">
                    <i class="fas fa-code"></i> Software development
                </button>
                <button onclick="sendSuggestion('What are the key topics covered in the lectures?')" class="chip">
                    <i class="fas fa-book-open"></i> Key topics
                </button>
                <button onclick="sendSuggestion('Help me understand project stakeholders')" class="chip">
                    <i class="fas fa-users"></i> Project stakeholders
                </button>
            </div>
        </div>
    `;
}

function scrollToBottom() {
    setTimeout(() => {
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }, 50);
}

// Auto-resize textarea
userInput.addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 120) + 'px';
});

// Focus input on page load
userInput.focus();

// Add fadeOut animation dynamically
const style = document.createElement('style');
style.textContent = `
    @keyframes fadeOut {
        from { opacity: 1; transform: translateY(0); }
        to { opacity: 0; transform: translateY(-10px); }
    }
`;
document.head.appendChild(style);

function showToast(message) {
    const toast = document.createElement('div');
    toast.style.cssText = `
        position: fixed; bottom: 80px; left: 50%; transform: translateX(-50%);
        background: var(--primary); color: white; padding: 10px 20px;
        border-radius: 20px; font-size: 13px; z-index: 1000;
        animation: fadeSlide 0.3s ease;
        box-shadow: 0 10px 30px rgba(0,0,0,0.3);
    `;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transition = 'opacity 0.3s';
        setTimeout(() => toast.remove(), 300);
    }, 2000);
}