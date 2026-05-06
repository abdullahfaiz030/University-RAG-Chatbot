const chatMessages = document.getElementById('chatMessages');
const userInput = document.getElementById('userInput');
const sendBtn = document.getElementById('sendBtn');
const docStatus = document.getElementById('docStatus');

let messageHistory = [];

// Initialize
checkSystemStatus();

async function checkSystemStatus() {
    try {
        const response = await fetch('/check-status');
        const data = await response.json();
        
        if (data.documents_available) {
            docStatus.textContent = `• ${data.document_count} documents`;
            docStatus.style.color = '#22c55e';
        } else {
            docStatus.textContent = '• No documents';
            docStatus.style.color = '#666';
        }
    } catch (error) {
        docStatus.textContent = '• Offline';
        docStatus.style.color = '#ef4444';
    }
}

function sendSuggestion(text) {
    userInput.value = text;
    sendMessage();
}

async function sendMessage() {
    const message = userInput.value.trim();
    if (!message) return;
    
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
        
        // Remove typing indicator
        removeTypingIndicator(typingId);
        
        // Add bot response
        if (data.response) {
            addMessage('bot', data.response, data.sources);
        }
    } catch (error) {
        removeTypingIndicator(typingId);
        addMessage('bot', 'Sorry, I encountered an error. Please try again.');
    } finally {
        sendBtn.disabled = false;
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
                Sources: ${sources.join(', ')}
            </div>
        `;
    }
    
    messageDiv.innerHTML = `
        <div class="message-avatar">
            <i class="fas ${avatarIcon}"></i>
        </div>
        <div class="message-bubble">
            <div>${content}</div>
            <div class="message-time">${time}</div>
            ${sourcesHtml}
        </div>
    `;
    
    // Remove welcome message if exists
    const welcomeMsg = chatMessages.querySelector('.welcome-message');
    if (welcomeMsg) {
        welcomeMsg.remove();
    }
    
    chatMessages.appendChild(messageDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
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
    chatMessages.scrollTop = chatMessages.scrollHeight;
    return id;
}

function removeTypingIndicator(id) {
    const element = document.getElementById(id);
    if (element) element.remove();
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
                <i class="fas fa-robot"></i>
            </div>
            <h3>New Conversation</h3>
            <p>Ask me anything about our documentation!</p>
        </div>
    `;
    messageHistory = [];
}

// Auto-resize textarea
userInput.addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 120) + 'px';
});