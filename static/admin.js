let selectedFiles = [];
let selectedCategory = '';
let allDocuments = [];

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    setupUploadZone();
    setupCategorySelector();
    loadStats();
});

function showSection(sectionName) {
    document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));
    event.target.closest('.nav-item').classList.add('active');
    
    document.querySelectorAll('.content-section').forEach(section => section.classList.remove('active'));
    document.getElementById(`${sectionName}-section`).classList.add('active');
    
    if (sectionName === 'documents') loadDocuments();
    if (sectionName === 'stats') loadStats();
}

// ============ CATEGORY MANAGEMENT ============

function setupCategorySelector() {
    document.querySelectorAll('.category-tag').forEach(tag => {
        tag.addEventListener('click', function() {
            document.querySelectorAll('.category-tag').forEach(t => t.classList.remove('active'));
            this.classList.add('active');
            selectedCategory = this.dataset.category;
            document.getElementById('currentFolder').textContent = selectedCategory || 'All Documents';
            document.getElementById('uploadCategoryText').textContent = selectedCategory || 'All Documents';
        });
    });
}

function addCustomCategory() {
    const input = document.getElementById('customCategory');
    const category = input.value.trim();
    
    if (!category) return;
    
    // Check if already exists
    const existing = document.querySelector(`.category-tag[data-category="${category}"]`);
    if (existing) {
        existing.click();
        input.value = '';
        return;
    }
    
    // Add new category tag
    const selector = document.getElementById('categorySelector');
    const tag = document.createElement('span');
    tag.className = 'category-tag';
    tag.dataset.category = category;
    tag.textContent = '📁 ' + category;
    tag.addEventListener('click', function() {
        document.querySelectorAll('.category-tag').forEach(t => t.classList.remove('active'));
        this.classList.add('active');
        selectedCategory = this.dataset.category;
        document.getElementById('currentFolder').textContent = selectedCategory;
        document.getElementById('uploadCategoryText').textContent = selectedCategory;
    });
    
    selector.appendChild(tag);
    tag.click();
    input.value = '';
}

function setCategory(category) {
    selectedCategory = category;
    document.getElementById('currentFolder').textContent = category || 'All Documents';
    document.getElementById('uploadCategoryText').textContent = category || 'All Documents';
    
    document.querySelectorAll('.category-tag').forEach(t => {
        t.classList.remove('active');
        if (t.dataset.category === category) t.classList.add('active');
    });
}

// ============ UPLOAD ============

function setupUploadZone() {
    const uploadZone = document.getElementById('uploadZone');
    const fileInput = document.getElementById('fileInput');
    
    uploadZone.addEventListener('click', () => fileInput.click());
    
    uploadZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        uploadZone.style.borderColor = '#6366f1';
        uploadZone.style.background = 'rgba(99, 102, 241, 0.08)';
    });
    
    uploadZone.addEventListener('dragleave', () => {
        uploadZone.style.borderColor = '#334155';
        uploadZone.style.background = '#334155';
    });
    
    uploadZone.addEventListener('drop', (e) => {
        e.preventDefault();
        uploadZone.style.borderColor = '#334155';
        uploadZone.style.background = '#334155';
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
                <span>${file.name}</span>
                <small style="color: var(--text-secondary); flex-shrink: 0;">${formatFileSize(file.size)}</small>
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
    uploadBtn.innerHTML = selectedFiles.length === 0 
        ? '<i class="fas fa-upload"></i> Select Files to Upload'
        : `<i class="fas fa-upload"></i> Upload ${selectedFiles.length} File(s) to ${selectedCategory || 'All Documents'}`;
}

async function uploadFiles() {
    if (selectedFiles.length === 0) return;
    
    const uploadBtn = document.getElementById('uploadBtn');
    const progressDiv = document.getElementById('uploadProgress');
    
    uploadBtn.disabled = true;
    uploadBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Uploading...';
    progressDiv.innerHTML = '<div class="loading-state"><i class="fas fa-spinner fa-spin"></i><p>Processing files...</p></div>';
    
    const formData = new FormData();
    selectedFiles.forEach(file => formData.append('files', file));
    
    // Add category to form data
    if (selectedCategory) {
        formData.append('category', selectedCategory);
    }
    
    try {
        const response = await fetch('/admin/upload', {
            method: 'POST',
            body: formData
        });
        
        const data = await response.json();
        
        if (data.uploaded && data.uploaded.length > 0) {
            progressDiv.innerHTML = `
                <div style="color: #22c55e; margin-top: 16px; padding: 16px; background: rgba(34,197,94,0.1); border-radius: 12px;">
                    <h3 style="margin-bottom: 8px;"><i class="fas fa-check-circle"></i> Upload Successful!</h3>
                    ${data.uploaded.map(file => `
                        <p style="margin: 4px 0; font-size: 13px;">✅ ${file.name} → ${selectedCategory || 'Root'} (${file.chunks} chunks)</p>
                    `).join('')}
                </div>
            `;
            
            selectedFiles = [];
            renderFileList();
            updateUploadButton();
            setTimeout(loadStats, 1000);
        }
        
        if (data.failed && data.failed.length > 0) {
            progressDiv.innerHTML += `
                <div style="color: #ef4444; margin-top: 10px; padding: 12px; background: rgba(239,68,68,0.1); border-radius: 10px;">
                    <h4 style="margin-bottom: 6px;">⚠️ Failed:</h4>
                    ${data.failed.map(file => `<p style="margin: 3px 0; font-size: 12px;">❌ ${file.name}: ${file.reason}</p>`).join('')}
                </div>
            `;
        }
    } catch (error) {
        progressDiv.innerHTML = `<div style="color: #ef4444; padding: 12px;">❌ Upload failed: ${error.message}</div>`;
    } finally {
        uploadBtn.disabled = false;
        uploadBtn.innerHTML = '<i class="fas fa-upload"></i> Upload to Database';
    }
}

// ============ DOCUMENTS ============

async function loadDocuments() {
    const documentsGrid = document.getElementById('documentsGrid');
    documentsGrid.innerHTML = '<div class="loading-state"><i class="fas fa-spinner fa-spin"></i><p>Loading...</p></div>';
    
    try {
        const response = await fetch('/admin/documents');
        const data = await response.json();
        
        if (data.documents && data.documents.length > 0) {
            allDocuments = data.documents;
            
            // Update category filter dropdown
            updateCategoryFilter();
            
            // Update quick folders
            updateQuickFolders();
            
            // Display documents
            renderDocumentList(allDocuments);
        } else {
            documentsGrid.innerHTML = `
                <div style="text-align: center; padding: 50px; color: var(--text-secondary);">
                    <i class="fas fa-folder-open" style="font-size: 50px; margin-bottom: 15px; opacity: 0.5;"></i>
                    <p style="font-size: 15px;">No documents uploaded yet</p>
                    <p style="font-size: 12px; margin-top: 4px;">Go to Upload section to add documents</p>
                </div>
            `;
            document.getElementById('quickFolders').innerHTML = '';
        }
    } catch (error) {
        documentsGrid.innerHTML = '<div style="color: #ef4444; text-align: center; padding: 20px;">Failed to load documents</div>';
    }
}

function updateCategoryFilter() {
    const select = document.getElementById('categoryFilter');
    const categories = new Set();
    
    allDocuments.forEach(doc => {
        if (doc.category) categories.add(doc.category);
    });
    
    select.innerHTML = '<option value="">All Categories</option>';
    categories.forEach(cat => {
        select.innerHTML += `<option value="${cat}">${cat}</option>`;
    });
}

function updateQuickFolders() {
    const quickFolders = document.getElementById('quickFolders');
    const categoryCount = {};
    
    allDocuments.forEach(doc => {
        const cat = doc.category || 'Uncategorized';
        categoryCount[cat] = (categoryCount[cat] || 0) + 1;
    });
    
    quickFolders.innerHTML = Object.entries(categoryCount).map(([cat, count]) => `
        <div class="quick-folder" onclick="filterByCategory('${cat}')">
            <i class="fas fa-folder${cat === 'Uncategorized' ? '' : '-open'}" style="color: ${getFolderColor(cat)};"></i>
            <span>${cat}</span>
            <span class="count">${count}</span>
        </div>
    `).join('');
}

function getFolderColor(category) {
    const colors = ['#6366f1', '#06b6d4', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899'];
    let hash = 0;
    for (let i = 0; i < category.length; i++) {
        hash = category.charCodeAt(i) + ((hash << 5) - hash);
    }
    return colors[Math.abs(hash) % colors.length];
}

function renderDocumentList(docs) {
    const documentsGrid = document.getElementById('documentsGrid');
    
    if (docs.length === 0) {
        documentsGrid.innerHTML = '<div style="text-align: center; padding: 30px; color: var(--text-secondary);">No documents match your search.</div>';
        return;
    }
    
    documentsGrid.innerHTML = docs.map(doc => `
        <div class="document-card">
            <div class="doc-info">
                <div class="doc-icon">
                    <i class="fas ${getFileIcon(doc.file_type)}" style="color: ${getFolderColor(doc.category || '')};"></i>
                </div>
                <div class="doc-details">
                    <h3>${doc.filename}</h3>
                    <div class="doc-meta">
                        <span><i class="fas fa-cubes"></i> ${doc.chunks} chunks</span>
                        <span><i class="far fa-clock"></i> ${formatDate(doc.upload_date)}</span>
                        <span><i class="fas fa-tag"></i> ${doc.file_type.toUpperCase()}</span>
                        ${doc.category ? `<span class="doc-category">📁 ${doc.category}</span>` : ''}
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
}

function filterDocuments() {
    const searchTerm = document.getElementById('docSearch').value.toLowerCase();
    const category = document.getElementById('categoryFilter').value;
    
    let filtered = allDocuments;
    
    if (searchTerm) {
        filtered = filtered.filter(doc => 
            doc.filename.toLowerCase().includes(searchTerm) ||
            (doc.category && doc.category.toLowerCase().includes(searchTerm))
        );
    }
    
    if (category) {
        filtered = filtered.filter(doc => doc.category === category);
    }
    
    renderDocumentList(filtered);
}

function filterByCategory(category) {
    document.getElementById('categoryFilter').value = category;
    filterDocuments();
}

async function deleteDocument(docId) {
    if (!confirm('Delete this document permanently? This action cannot be undone.')) return;
    
    try {
        const response = await fetch(`/admin/delete/${docId}`, { method: 'DELETE' });
        const data = await response.json();
        
        if (data.success) {
            loadDocuments();
            loadStats();
        } else {
            alert('Failed to delete document');
        }
    } catch (error) {
        alert('Error deleting document');
    }
}

// ============ STATISTICS ============

async function loadStats() {
    try {
        const response = await fetch('/admin/stats');
        const data = await response.json();
        
        document.getElementById('statDocuments').textContent = data.total_documents || 0;
        document.getElementById('statChunks').textContent = data.total_chunks || 0;
        
        // Count unique categories
        const categories = new Set();
        if (allDocuments.length > 0) {
            allDocuments.forEach(doc => {
                if (doc.category) categories.add(doc.category);
            });
        }
        document.getElementById('statCategories').textContent = categories.size || 0;
        document.getElementById('statStorage').textContent = '~50 MB';
    } catch (error) {
        console.error('Failed to load stats:', error);
    }
}

// ============ UTILITIES ============

function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatDate(dateString) {
    try {
        return new Date(dateString).toLocaleDateString('en-US', {
            year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
        });
    } catch {
        return dateString;
    }
}

function getFileIcon(fileType) {
    const icons = {
        'pdf': 'fa-file-pdf', 'docx': 'fa-file-word', 'txt': 'fa-file-alt',
        'csv': 'fa-file-csv', 'xlsx': 'fa-file-excel', 'xls': 'fa-file-excel'
    };
    return icons[fileType.toLowerCase()] || 'fa-file';
}