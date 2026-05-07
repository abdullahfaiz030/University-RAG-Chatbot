const chatMessages = document.getElementById('chatMessages');
const userInput = document.getElementById('userInput');
const sendBtn = document.getElementById('sendBtn');
const docStatus = document.getElementById('docStatus');

let isProcessing = false;

// Initialize
checkSystemStatus();

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
            body: JSON.stringify({ message })
        });
        
        const data = await response.json();
        removeTypingIndicator(typingId);
        
        if (data.response) {
            addMessage('bot', data.response, data.sources);
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

function addMessage(type, content, sources = null) {
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${type}-message`;
    
    const avatarIcon = type === 'user' ? 'fa-user' : 'fa-robot';
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    
    let sourcesHtml = '';
    if (sources && sources.length > 0) {
        sourcesHtml = `
            <div class="message-sources">
                <i class="fas fa-file-alt"></i>
                Based on: ${sources.slice(0, 2).join(', ')}
            </div>
        `;
    }
    
    // Format content with simple markdown-like parsing
    const formattedContent = formatMessage(content);
    
    messageDiv.innerHTML = `
        <div class="message-avatar">
            <i class="fas ${avatarIcon}"></i>
        </div>
        <div class="message-bubble">
            <div class="message-text">${formattedContent}</div>
            <div class="message-time">${time}</div>
            ${sourcesHtml}
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
}

function formatMessage(text) {
    // Convert URLs to links
    text = text.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" style="color: #818cf8;">$1</a>');
    
    // Convert bold text
    text = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    
    // Convert line breaks
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