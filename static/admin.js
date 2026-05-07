let selectedFiles = [];
let allDocuments = [];
let folderStructure = {};

// Navigation state
let uploadPath = [];
let browsePath = [];

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    setupUploadZone();
    loadFolderStructure();
    loadStats();
});

function showSection(sectionName) {
    document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));
    event.target.closest('.nav-item').classList.add('active');
    
    document.querySelectorAll('.content-section').forEach(section => section.classList.remove('active'));
    document.getElementById(`${sectionName}-section`).classList.add('active');
    
    if (sectionName === 'documents') loadAllDocuments();
    if (sectionName === 'browse') renderBrowseView();
    if (sectionName === 'stats') loadStats();
}

// ============ FOLDER STRUCTURE ============

async function loadFolderStructure() {
    try {
        const response = await fetch('/admin/documents');
        const data = await response.json();
        
        if (data.documents) {
            allDocuments = data.documents;
            buildFolderStructure();
            renderUploadFolders();
        }
    } catch (error) {
        console.error('Failed to load folder structure:', error);
    }
}

function buildFolderStructure() {
    folderStructure = {};
    
    allDocuments.forEach(doc => {
        const path = doc.category || 'Uncategorized';
        const parts = path.split('/');
        
        let current = folderStructure;
        parts.forEach((part, index) => {
            if (!current[part]) {
                current[part] = {
                    name: part,
                    files: [],
                    subfolders: {},
                    count: 0
                };
            }
            if (index === parts.length - 1) {
                current[part].files.push(doc);
                current[part].count++;
            }
            current = current[part].subfolders;
        });
    });
    
    // Count total items in each folder
    countFolderItems(folderStructure);
}

function countFolderItems(structure) {
    Object.values(structure).forEach(folder => {
        let total = folder.files.length;
        Object.values(folder.subfolders).forEach(sub => {
            total += countFolderItems({sub}) || sub.count;
        });
        folder.totalItems = total;
    });
    return Object.values(structure).reduce((sum, f) => sum + f.totalItems, 0);
}

// ============ UPLOAD SECTION ============

function renderUploadFolders() {
    const container = document.getElementById('uploadFolders');
    let current = folderStructure;
    
    // Navigate to current path
    uploadPath.forEach(part => {
        if (current[part]) current = current[part].subfolders;
    });
    
    // Update breadcrumb
    updateUploadBreadcrumb();
    
    // Render subfolders
    const folders = Object.entries(current);
    
    if (folders.length === 0) {
        container.innerHTML = `
            <div style="grid-column: 1/-1; text-align: center; padding: 30px; color: var(--text-secondary);">
                <i class="fas fa-folder-open" style="font-size: 40px; opacity: 0.3; margin-bottom: 10px; display: block;"></i>
                <p>This folder is empty</p>
                <p style="font-size: 11px;">Create a subfolder or upload files here</p>
            </div>
        `;
    } else {
        container.innerHTML = folders.map(([name, folder]) => `
            <div class="folder-card" onclick="navigateUploadPath([...uploadPath, '${name.replace(/'/g, "\\'")}'])">
                <i class="fas fa-folder folder-icon" style="color: ${getFolderColor(name)};"></i>
                <div class="folder-name">${name}</div>
                <div class="folder-info">${folder.totalItems || folder.files.length} items</div>
                ${folder.totalItems > 0 ? `<span class="folder-badge">${folder.totalItems}</span>` : ''}
            </div>
        `).join('');
    }
    
    // Show files in current folder
    let currentFolder = folderStructure;
    uploadPath.forEach(part => {
        if (currentFolder[part]) currentFolder = currentFolder[part];
    });
    
    const files = currentFolder.files || [];
    if (files.length > 0) {
        container.innerHTML += `
            <div style="grid-column: 1/-1; margin-top: 8px; padding-top: 16px; border-top: 1px solid var(--border);">
                <p style="font-size: 12px; color: var(--text-secondary); margin-bottom: 8px;">
                    <i class="fas fa-file-alt"></i> ${files.length} file(s) in this folder
                </p>
            </div>
        `;
    }
}

function navigateUploadPath(path) {
    uploadPath = path;
    renderUploadFolders();
    document.getElementById('uploadCategoryText').textContent = path.join(' / ') || 'Root';
}

function updateUploadBreadcrumb() {
    const breadcrumb = document.getElementById('uploadBreadcrumb');
    let html = '<span class="breadcrumb-item" onclick="navigateUploadPath([])">🏠 Root</span>';
    
    uploadPath.forEach((part, index) => {
        const path = uploadPath.slice(0, index + 1);
        html += ` › <span class="breadcrumb-item" onclick="navigateUploadPath(${JSON.stringify(path)})">📁 ${part}</span>`;
    });
    
    breadcrumb.innerHTML = html;
}

function createNewFolder(type) {
    const input = document.getElementById('newFolderName');
    const name = input.value.trim();
    
    if (!name) return;
    
    const path = type === 'upload' ? uploadPath : browsePath;
    const fullPath = [...path, name].join('/');
    
    // Add to folder structure
    let current = folderStructure;
    path.forEach(part => {
        if (!current[part]) {
            current[part] = { name: part, files: [], subfolders: {}, count: 0, totalItems: 0 };
        }
        current = current[part].subfolders;
    });
    
    if (!current[name]) {
        current[name] = { name: name, files: [], subfolders: {}, count: 0, totalItems: 0 };
    }
    
    input.value = '';
    
    if (type === 'upload') {
        renderUploadFolders();
    } else {
        renderBrowseView();
    }
    
    // Show success toast
    showToast(`Folder "${name}" created!`);
}

function getCurrentUploadPath() {
    return uploadPath.join('/');
}

// ============ BROWSE SECTION ============

function renderBrowseView() {
    updateBrowseBreadcrumb();
    renderBrowseFolders();
    renderBrowseFiles();
}

function updateBrowseBreadcrumb() {
    const breadcrumb = document.getElementById('browseBreadcrumb');
    let html = '<span class="breadcrumb-item active" onclick="navigateBrowsePath([])">🏠 Root</span>';
    
    browsePath.forEach((part, index) => {
        const path = browsePath.slice(0, index + 1);
        html += ` › <span class="breadcrumb-item active" onclick="navigateBrowsePath(${JSON.stringify(path)})">📁 ${part}</span>`;
    });
    
    breadcrumb.innerHTML = html;
}

function navigateBrowsePath(path) {
    browsePath = path;
    renderBrowseView();
}

function renderBrowseFolders() {
    const container = document.getElementById('browseFolders');
    let current = folderStructure;
    
    browsePath.forEach(part => {
        if (current[part]) current = current[part].subfolders;
    });
    
    const folders = Object.entries(current);
    
    if (folders.length === 0) {
        container.innerHTML = `
            <div style="grid-column: 1/-1; text-align: center; padding: 40px; color: var(--text-secondary);">
                <i class="fas fa-folder-open" style="font-size: 50px; opacity: 0.3; margin-bottom: 12px; display: block;"></i>
                <p style="font-size: 14px;">No subfolders here</p>
            </div>
        `;
    } else {
        container.innerHTML = folders.map(([name, folder]) => `
            <div class="folder-card" ondblclick="navigateBrowsePath([...browsePath, '${name.replace(/'/g, "\\'")}'])">
                <i class="fas fa-folder folder-icon" style="color: ${getFolderColor(name)};"></i>
                <div class="folder-name">${name}</div>
                <div class="folder-info">
                    ${Object.keys(folder.subfolders).length} subfolders • ${folder.files.length} files
                </div>
                <span class="folder-badge">${folder.totalItems || folder.files.length}</span>
                <button class="action-btn" onclick="event.stopPropagation(); navigateBrowsePath([...browsePath, '${name.replace(/'/g, "\\'")}'])" 
                        style="margin-top: 8px; width: 100%;">
                    <i class="fas fa-arrow-right"></i> Open
                </button>
            </div>
        `).join('');
    }
}

function renderBrowseFiles() {
    const container = document.getElementById('browseFiles');
    let current = folderStructure;
    
    browsePath.forEach(part => {
        if (current[part]) current = current[part];
    });
    
    const files = current.files || [];
    
    if (files.length === 0) {
        container.innerHTML = `
            <div style="text-align: center; padding: 30px; color: var(--text-secondary);">
                <i class="fas fa-file-alt" style="font-size: 30px; opacity: 0.3; margin-bottom: 8px; display: block;"></i>
                <p style="font-size: 13px;">No files in this folder</p>
            </div>
        `;
        return;
    }
    
    container.innerHTML = files.map(doc => `
        <div class="file-card">
            <i class="fas ${getFileIcon(doc.file_type)} file-icon" style="color: ${getFolderColor(doc.file_type)};"></i>
            <div class="file-details">
                <div class="file-name">${doc.filename}</div>
                <div class="file-meta">
                    ${doc.chunks} chunks • ${formatDate(doc.upload_date)} • ${doc.file_type.toUpperCase()}
                </div>
            </div>
            <button class="action-btn delete-btn" onclick="deleteDocument('${doc.doc_id}')" style="flex-shrink: 0;">
                <i class="fas fa-trash"></i>
            </button>
        </div>
    `).join('');
}

// ============ ALL DOCUMENTS ============

async function loadAllDocuments() {
    const grid = document.getElementById('allDocumentsGrid');
    grid.innerHTML = '<div class="loading-state"><i class="fas fa-spinner fa-spin"></i><p>Loading...</p></div>';
    
    try {
        const response = await fetch('/admin/documents');
        const data = await response.json();
        
        if (data.documents && data.documents.length > 0) {
            allDocuments = data.documents;
            renderAllDocuments(allDocuments);
        } else {
            grid.innerHTML = `
                <div style="text-align: center; padding: 50px; color: var(--text-secondary);">
                    <i class="fas fa-folder-open" style="font-size: 50px; opacity: 0.5;"></i>
                    <p>No documents uploaded yet</p>
                </div>
            `;
        }
    } catch (error) {
        grid.innerHTML = '<div style="color: #ef4444; text-align: center;">Failed to load</div>';
    }
}

function renderAllDocuments(docs) {
    const grid = document.getElementById('allDocumentsGrid');
    
    if (docs.length === 0) {
        grid.innerHTML = '<div style="text-align: center; padding: 30px; color: var(--text-secondary);">No documents found.</div>';
        return;
    }
    
    grid.innerHTML = docs.map(doc => `
        <div class="file-card">
            <i class="fas ${getFileIcon(doc.file_type)} file-icon" style="color: ${getFolderColor(doc.file_type)};"></i>
            <div class="file-details">
                <div class="file-name">${doc.filename}</div>
                <div class="file-meta">
                    ${doc.category ? `📁 ${doc.category} • ` : ''}${doc.chunks} chunks • ${formatDate(doc.upload_date)}
                </div>
            </div>
            <button class="action-btn delete-btn" onclick="deleteDocument('${doc.doc_id}')">
                <i class="fas fa-trash"></i>
            </button>
        </div>
    `).join('');
}

function filterAllDocuments() {
    const search = document.getElementById('docSearch').value.toLowerCase();
    const filtered = allDocuments.filter(doc => 
        doc.filename.toLowerCase().includes(search) ||
        (doc.category && doc.category.toLowerCase().includes(search))
    );
    renderAllDocuments(filtered);
}

// ============ UPLOAD ============

function setupUploadZone() {
    const uploadZone = document.getElementById('uploadZone');
    const fileInput = document.getElementById('fileInput');
    
    uploadZone.addEventListener('click', () => fileInput.click());
    
    uploadZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        uploadZone.style.borderColor = '#6366f1';
    });
    
    uploadZone.addEventListener('dragleave', () => {
        uploadZone.style.borderColor = '#334155';
    });
    
    uploadZone.addEventListener('drop', (e) => {
        e.preventDefault();
        uploadZone.style.borderColor = '#334155';
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
                <small>${formatFileSize(file.size)}</small>
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
    const path = uploadPath.join(' / ') || 'Root';
    uploadBtn.innerHTML = selectedFiles.length === 0 
        ? '<i class="fas fa-upload"></i> Select Files'
        : `<i class="fas fa-upload"></i> Upload ${selectedFiles.length} File(s) to "${path}"`;
}

async function uploadFiles() {
    if (selectedFiles.length === 0) return;
    
    const uploadBtn = document.getElementById('uploadBtn');
    const progressDiv = document.getElementById('uploadProgress');
    const category = uploadPath.join('/');
    
    uploadBtn.disabled = true;
    uploadBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Uploading...';
    
    const formData = new FormData();
    selectedFiles.forEach(file => formData.append('files', file));
    if (category) formData.append('category', category);
    
    try {
        const response = await fetch('/admin/upload', {
            method: 'POST',
            body: formData
        });
        
        const data = await response.json();
        
        if (data.uploaded && data.uploaded.length > 0) {
            progressDiv.innerHTML = `
                <div style="color: #22c55e; margin-top: 16px; padding: 16px; background: rgba(34,197,94,0.1); border-radius: 12px;">
                    ✅ Uploaded ${data.uploaded.length} file(s) to "${category || 'Root'}"
                </div>
            `;
            
            selectedFiles = [];
            renderFileList();
            updateUploadButton();
            setTimeout(() => {
                loadFolderStructure();
                loadStats();
            }, 1000);
        }
        
        if (data.failed && data.failed.length > 0) {
            progressDiv.innerHTML += `
                <div style="color: #ef4444; margin-top: 8px; font-size: 12px;">
                    ⚠️ ${data.failed.length} failed
                </div>
            `;
        }
    } catch (error) {
        progressDiv.innerHTML = `<div style="color: #ef4444;">❌ Upload failed</div>`;
    } finally {
        uploadBtn.disabled = false;
        updateUploadButton();
    }
}

// ============ STATISTICS ============

async function loadStats() {
    try {
        const response = await fetch('/admin/stats');
        const data = await response.json();
        
        document.getElementById('statDocuments').textContent = data.total_documents || 0;
        document.getElementById('statChunks').textContent = data.total_chunks || 0;
        
        // Count folders
        let folderCount = 0;
        function countFolders(obj) {
            Object.keys(obj).forEach(key => {
                folderCount++;
                if (obj[key].subfolders) countFolders(obj[key].subfolders);
            });
        }
        countFolders(folderStructure);
        document.getElementById('statFolders').textContent = folderCount;
        document.getElementById('statStorage').textContent = '~50 MB';
        
        // Render folder tree
        renderFolderTree();
    } catch (error) {
        console.error('Stats error:', error);
    }
}

function renderFolderTree() {
    const container = document.getElementById('folderTreeView');
    container.innerHTML = buildTreeHTML(folderStructure, 0);
    
    // Add click handlers
    document.querySelectorAll('.tree-toggle').forEach(toggle => {
        toggle.addEventListener('click', function() {
            const children = this.parentElement.querySelector('.tree-children');
            if (children) {
                children.style.display = children.style.display === 'none' ? 'block' : 'none';
                this.classList.toggle('open');
            }
        });
    });
}

function buildTreeHTML(structure, level) {
    let html = '';
    
    Object.entries(structure).forEach(([name, folder]) => {
        const hasChildren = Object.keys(folder.subfolders).length > 0;
        
        html += `<div class="tree-item" style="padding-left: ${level * 16}px;">`;
        if (hasChildren) {
            html += `<span class="tree-toggle open">▶</span>`;
        } else {
            html += `<span style="width: 16px; display: inline-block;"></span>`;
        }
        html += `<i class="fas fa-folder" style="color: ${getFolderColor(name)};"></i>`;
        html += `<span>${name}</span>`;
        html += `<span style="margin-left: auto; font-size: 11px; color: var(--text-secondary);">${folder.files.length} files</span>`;
        html += `</div>`;
        
        if (hasChildren) {
            html += `<div class="tree-children">`;
            html += buildTreeHTML(folder.subfolders, level + 1);
            html += `</div>`;
        }
    });
    
    return html;
}

// ============ DELETE ============

async function deleteDocument(docId) {
    if (!confirm('Delete this document permanently?')) return;
    
    try {
        const response = await fetch(`/admin/delete/${docId}`, { method: 'DELETE' });
        const data = await response.json();
        
        if (data.success) {
            loadFolderStructure();
            loadAllDocuments();
            loadStats();
            if (document.getElementById('browse-section').classList.contains('active')) {
                renderBrowseView();
            }
            showToast('Document deleted!');
        }
    } catch (error) {
        alert('Failed to delete');
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
            year: 'numeric', month: 'short', day: 'numeric'
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

function getFolderColor(name) {
    const colors = ['#6366f1', '#06b6d4', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6'];
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
        hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    return colors[Math.abs(hash) % colors.length];
}

function showToast(message) {
    const toast = document.createElement('div');
    toast.style.cssText = `
        position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
        background: var(--primary); color: white; padding: 12px 24px;
        border-radius: 25px; font-size: 14px; z-index: 1000;
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