let selectedFiles = [];

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    setupUploadZone();
    loadStats();
});

function showSection(sectionName) {
    // Update nav
    document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));
    event.target.closest('.nav-item').classList.add('active');
    
    // Show section
    document.querySelectorAll('.content-section').forEach(section => section.classList.remove('active'));
    document.getElementById(`${sectionName}-section`).classList.add('active');
    
    // Load data
    if (sectionName === 'documents') loadDocuments();
    if (sectionName === 'stats') loadStats();
}

function setupUploadZone() {
    const uploadZone = document.getElementById('uploadZone');
    const fileInput = document.getElementById('fileInput');
    
    uploadZone.addEventListener('click', () => fileInput.click());
    
    uploadZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        uploadZone.style.borderColor = '#6c5ce7';
    });
    
    uploadZone.addEventListener('dragleave', () => {
        uploadZone.style.borderColor = '#2a2a2a';
    });
    
    uploadZone.addEventListener('drop', (e) => {
        e.preventDefault();
        uploadZone.style.borderColor = '#2a2a2a';
        addFiles(Array.from(e.dataTransfer.files));
    });
    
    fileInput.addEventListener('change', () => {
        addFiles(Array.from(fileInput.files));
        fileInput.value = '';
    });
}

function addFiles(files) {
    selectedFiles = [...selectedFiles, ...files];
    renderFileList();
    updateUploadButton();
}

function removeFile(index) {
    selectedFiles.splice(index, 1);
    renderFileList();
    updateUploadButton();
}

function renderFileList() {
    const uploadList = document.getElementById('uploadList');
    
    if (selectedFiles.length === 0) {
        uploadList.innerHTML = '';
        return;
    }
    
    uploadList.innerHTML = selectedFiles.map((file, index) => `
        <div class="file-item">
            <div class="file-info">
                <i class="fas fa-file-alt"></i>
                <div>
                    <div>${file.name}</div>
                    <small style="color: #888;">${formatFileSize(file.size)}</small>
                </div>
            </div>
            <button class="remove-file-btn" onclick="removeFile(${index})">
                <i class="fas fa-times"></i>
            </button>
        </div>
    `).join('');
}

function updateUploadButton() {
    const uploadBtn = document.getElementById('uploadBtn');
    uploadBtn.disabled = selectedFiles.length === 0;
    uploadBtn.textContent = selectedFiles.length === 0 
        ? '<i class="fas fa-upload"></i> Select Files to Upload'
        : `<i class="fas fa-upload"></i> Upload ${selectedFiles.length} File(s)`;
}

async function uploadFiles() {
    if (selectedFiles.length === 0) return;
    
    const uploadBtn = document.getElementById('uploadBtn');
    const progressDiv = document.getElementById('uploadProgress');
    
    // Disable upload button
    uploadBtn.disabled = true;
    uploadBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Uploading...';
    
    // Show progress
    progressDiv.innerHTML = '<div class="loading-state"><i class="fas fa-spinner fa-spin"></i><p>Processing files...</p></div>';
    
    const formData = new FormData();
    selectedFiles.forEach(file => {
        formData.append('files', file);
    });
    
    try {
        const response = await fetch('/admin/upload', {
            method: 'POST',
            body: formData
        });
        
        const data = await response.json();
        
        if (data.uploaded && data.uploaded.length > 0) {
            progressDiv.innerHTML = `
                <div style="color: #22c55e; margin-top: 20px;">
                    <h3><i class="fas fa-check-circle"></i> Upload Successful</h3>
                    ${data.uploaded.map(file => `
                        <p style="margin: 5px 0; color: #888;">✅ ${file.name} (${file.chunks} chunks)</p>
                    `).join('')}
                </div>
            `;
            
            // Clear selected files
            selectedFiles = [];
            renderFileList();
            updateUploadButton();
            
            // Reload stats
            setTimeout(loadStats, 1000);
        }
        
        if (data.failed && data.failed.length > 0) {
            progressDiv.innerHTML += `
                <div style="color: #ef4444; margin-top: 10px;">
                    <h4>Failed Uploads:</h4>
                    ${data.failed.map(file => `
                        <p style="margin: 5px 0;">❌ ${file.name}: ${file.reason}</p>
                    `).join('')}
                </div>
            `;
        }
    } catch (error) {
        progressDiv.innerHTML = `
            <div style="color: #ef4444;">
                <i class="fas fa-exclamation-circle"></i> Upload failed: ${error.message}
            </div>
        `;
    } finally {
        uploadBtn.disabled = false;
        uploadBtn.innerHTML = '<i class="fas fa-upload"></i> Upload to Database';
    }
}

async function loadDocuments() {
    const documentsGrid = document.getElementById('documentsGrid');
    documentsGrid.innerHTML = '<div class="loading-state"><i class="fas fa-spinner fa-spin"></i><p>Loading documents...</p></div>';
    
    try {
        const response = await fetch('/admin/documents');
        const data = await response.json();
        
        if (data.documents && data.documents.length > 0) {
            documentsGrid.innerHTML = data.documents.map(doc => `
                <div class="document-card">
                    <div class="doc-info">
                        <div class="doc-icon">
                            <i class="fas ${getFileIcon(doc.file_type)}"></i>
                        </div>
                        <div class="doc-details">
                            <h3>${doc.filename}</h3>
                            <div class="doc-meta">
                                <span><i class="fas fa-cubes"></i> ${doc.chunks} chunks</span>
                                <span><i class="far fa-clock"></i> ${formatDate(doc.upload_date)}</span>
                                <span><i class="fas fa-tag"></i> ${doc.file_type.toUpperCase()}</span>
                            </div>
                        </div>
                    </div>
                    <div class="doc-actions">
                        <button class="action-btn delete-btn" onclick="deleteDocument('${doc.doc_id}')">
                            <i class="fas fa-trash"></i> Delete
                        </button>
                    </div>
                </div>
            `).join('');
        } else {
            documentsGrid.innerHTML = `
                <div style="text-align: center; padding: 40px; color: #888;">
                    <i class="fas fa-folder-open" style="font-size: 48px; margin-bottom: 15px;"></i>
                    <p>No documents uploaded yet</p>
                </div>
            `;
        }
    } catch (error) {
        documentsGrid.innerHTML = '<div style="color: #ef4444;">Failed to load documents</div>';
    }
}

async function deleteDocument(docId) {
    if (!confirm('Are you sure you want to delete this document and all its associated data?')) {
        return;
    }
    
    try {
        const response = await fetch(`/admin/delete/${docId}`, {
            method: 'DELETE'
        });
        
        const data = await response.json();
        
        if (data.success) {
            loadDocuments();
            loadStats();
        }
    } catch (error) {
        alert('Failed to delete document');
    }
}

async function loadStats() {
    try {
        const response = await fetch('/admin/stats');
        const data = await response.json();
        
        document.getElementById('statDocuments').textContent = data.total_documents || 0;
        document.getElementById('statChunks').textContent = data.total_chunks || 0;
        document.getElementById('statStorage').textContent = '0 MB';
        document.getElementById('statLastUpload').textContent = 'Now';
    } catch (error) {
        console.error('Failed to load stats:', error);
    }
}

function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatDate(dateString) {
    try {
        const date = new Date(dateString);
        return date.toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    } catch {
        return dateString;
    }
}

function getFileIcon(fileType) {
    const icons = {
        'pdf': 'fa-file-pdf',
        'docx': 'fa-file-word',
        'txt': 'fa-file-alt',
        'csv': 'fa-file-csv',
        'xlsx': 'fa-file-excel',
        'xls': 'fa-file-excel'
    };
    return icons[fileType.toLowerCase()] || 'fa-file';
}