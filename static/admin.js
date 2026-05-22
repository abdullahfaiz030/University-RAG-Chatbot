let selectedFiles = [];
let allDocuments = [];
let folderStructure = {};

// Navigation state
let uploadPath = [];
let browsePath = [];
let isRestoringHistory = false;

function getStateUrl(type, path) {
    const encodedPath = path.map(part => encodeURIComponent(part)).join('/');
    const section = type === 'upload' ? 'upload' : 'browse';
    return `${location.pathname}#${section}${encodedPath ? '/' + encodedPath : ''}`;
}

function pushPathHistory(type) {
    if (!window.history || isRestoringHistory) return;
    const path = type === 'upload' ? uploadPath : browsePath;
    const state = { type: type, path: [...path] };
    const url = getStateUrl(type, path);
    window.history.pushState(state, '', url);
}

window.addEventListener('popstate', (event) => {
    console.log('popstate event:', event.state);
    isRestoringHistory = true;
    
    try {
        if (event.state && event.state.type === 'upload') {
            uploadPath = Array.isArray(event.state.path) ? [...event.state.path] : [];
            console.log('Restored uploadPath:', uploadPath);
            if (!document.getElementById('upload-section')?.classList.contains('active')) {
                showSection('upload');
            } else {
                renderUploadFolders();
            }
        } else if (event.state && event.state.type === 'browse') {
            browsePath = Array.isArray(event.state.path) ? [...event.state.path] : [];
            console.log('Restored browsePath:', browsePath);
            if (!document.getElementById('browse-section')?.classList.contains('active')) {
                showSection('browse');
            } else {
                renderBrowseView();
            }
        } else {
            console.log('popstate with no valid state, resetting to browse root');
            browsePath = [];
            if (document.getElementById('browse-section')?.classList.contains('active')) {
                renderBrowseView();
            }
        }
    } finally {
        isRestoringHistory = false;
    }
});

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    setupUploadZone();
    loadFolderStructure();
    loadStats();
    window.history.replaceState({ type: 'browse', path: [] }, '', getStateUrl('browse', []));
});

function showSection(sectionName) {
    document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));
    event.target.closest('.nav-item').classList.add('active');
    
    document.querySelectorAll('.content-section').forEach(section => section.classList.remove('active'));
    document.getElementById(`${sectionName}-section`).classList.add('active');
    
    if (sectionName === 'documents') loadAllDocuments();
    if (sectionName === 'browse') {
        loadFolderStructure().then(() => renderBrowseView());
    }
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
            return true;
        }
    } catch (error) {
        console.error('Failed to load folder structure:', error);
    }
    return false;
}

function buildFolderStructure() {
    folderStructure = {};
    
    allDocuments.forEach(doc => {
        const path = doc.category || '';
        if (!path || path.trim() === '') {
            if (!folderStructure['_root_files']) {
                folderStructure['_root_files'] = [];
            }
            folderStructure['_root_files'].push(doc);
            return;
        }
        
        const parts = path.split('/').filter(p => p.trim() !== '');
        
        let current = folderStructure;
        parts.forEach((part, index) => {
            if (!current[part]) {
                current[part] = {
                    name: part,
                    files: [],
                    subfolders: {},
                    count: 0,
                    totalItems: 0
                };
            }
            if (index === parts.length - 1) {
                current[part].files.push(doc);
                current[part].count = current[part].files.length;
            }
            current = current[part].subfolders;
        });
    });
    
    countFolderItems(folderStructure);
}

function countFolderItems(structure) {
    let total = 0;
    Object.entries(structure).forEach(([key, folder]) => {
        if (key === '_root_files') return;
        let subTotal = (folder.files || []).length;
        if (folder.subfolders && Object.keys(folder.subfolders).length > 0) {
            subTotal += countFolderItems(folder.subfolders);
        }
        folder.totalItems = subTotal;
        total += subTotal;
    });
    return total;
}

// ============ NAVIGATION (FIXED) ============

function goToPath(type, depth) {
    console.log(`goToPath: type=${type}, depth=${depth}`);
    
    if (type === 'upload') {
        if (depth === 0) {
            uploadPath = [];
        } else if (depth > 0 && depth <= uploadPath.length) {
            uploadPath = uploadPath.slice(0, depth);
        } else if (depth > uploadPath.length) {
            console.warn(`Invalid depth ${depth} for uploadPath length ${uploadPath.length}`);
            return;
        }
        console.log('Upload path now:', uploadPath);
        renderUploadFolders();
        pushPathHistory('upload');
    } else if (type === 'browse') {
        if (depth === 0) {
            browsePath = [];
        } else if (depth > 0 && depth <= browsePath.length) {
            browsePath = browsePath.slice(0, depth);
        } else if (depth > browsePath.length) {
            console.warn(`Invalid depth ${depth} for browsePath length ${browsePath.length}`);
            return;
        }
        console.log('Browse path now:', browsePath);
        renderBrowseView();
        pushPathHistory('browse');
    }
}

function enterFolder(type, folderName) {
    console.log(`enterFolder: type=${type}, name=${folderName}`);
    if (type === 'upload') {
        uploadPath.push(folderName);
        renderUploadFolders();
        pushPathHistory('upload');
    } else if (type === 'browse') {
        browsePath.push(folderName);
        renderBrowseView();
        pushPathHistory('browse');
    }
}

// ============ UPLOAD SECTION ============

function renderUploadFolders() {
    const container = document.getElementById('uploadFolders');
    if (!container) return;
    
    let current = folderStructure;
    uploadPath.forEach(part => {
        if (current[part]) current = current[part].subfolders;
    });
    
    updateBreadcrumb('upload');
    
    const folders = Object.entries(current).filter(([key]) => key !== '_root_files');
    
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
            <div class="folder-card" onclick="enterFolder('upload', '${name.replace(/'/g, "\\'")}')">
                <i class="fas fa-folder folder-icon" style="color: ${getFolderColor(name)};"></i>
                <div class="folder-name">${name}</div>
                <div class="folder-info">${folder.totalItems || 0} items</div>
                ${folder.totalItems > 0 ? `<span class="folder-badge">${folder.totalItems}</span>` : ''}
            </div>
        `).join('');
    }
}

// ============ BROWSE SECTION ============

function renderBrowseView() {
    updateBreadcrumb('browse');
    renderBrowseFolders();
    renderBrowseFiles();
}

function renderBrowseFolders() {
    const container = document.getElementById('browseFolders');
    if (!container) return;
    
    let current = folderStructure;
    for (let i = 0; i < browsePath.length; i++) {
        const part = browsePath[i];
        if (current[part] && current[part].subfolders) {
            current = current[part].subfolders;
        } else {
            current = {};
            break;
        }
    }
    
    const folders = Object.entries(current).filter(([key]) => key !== '_root_files');
    
    if (folders.length === 0) {
        container.innerHTML = `
            <div style="grid-column: 1/-1; text-align: center; padding: 30px; color: var(--text-secondary);">
                <i class="fas fa-folder-open" style="font-size: 40px; opacity: 0.3; margin-bottom: 10px; display: block;"></i>
                <p>No subfolders here</p>
            </div>
        `;
    } else {
        container.innerHTML = folders.map(([name, folder]) => `
            <div class="folder-card">
                <i class="fas fa-folder folder-icon" style="color: ${getFolderColor(name)};"></i>
                <div class="folder-name">${name}</div>
                <div class="folder-info">
                    ${Object.keys(folder.subfolders || {}).length} subfolders • ${(folder.files || []).length} files
                </div>
                <span class="folder-badge">${folder.totalItems || 0}</span>
                <div style="display: flex; gap: 6px; margin-top: 8px;">
                    <button class="action-btn" onclick="event.stopPropagation(); enterFolder('browse', '${name.replace(/'/g, "\\'")}')" style="flex: 1;">
                        <i class="fas fa-arrow-right"></i> Open
                    </button>
                    <button class="action-btn" onclick="event.stopPropagation(); renameFolder('${name.replace(/'/g, "\\'")}')" title="Rename">
                        <i class="fas fa-edit"></i>
                    </button>
                    <button class="action-btn delete-btn" onclick="event.stopPropagation(); deleteFolder('${name.replace(/'/g, "\\'")}')" title="Delete">
                        <i class="fas fa-trash"></i>
                    </button>
                </div>
            </div>
        `).join('');
    }
}

function renderBrowseFiles() {
    const container = document.getElementById('browseFiles');
    if (!container) return;
    
    let files = [];
    
    if (browsePath.length === 0) {
        if (folderStructure['_root_files']) {
            files = folderStructure['_root_files'];
        }
    } else {
        let current = folderStructure;
        for (let i = 0; i < browsePath.length; i++) {
            const part = browsePath[i];
            if (current[part]) {
                if (i === browsePath.length - 1) {
                    files = current[part].files || [];
                } else {
                    current = current[part].subfolders || {};
                }
            } else {
                files = [];
                break;
            }
        }
    }
    
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
            <i class="fas ${getFileIcon(doc.file_type)} file-icon" style="color: ${getFolderColor(doc.file_type || '')};"></i>
            <div class="file-details">
                <div class="file-name">${doc.filename}</div>
                <div class="file-meta">
                    ${doc.file_type ? doc.file_type.toUpperCase() : ''} • ${formatDate(doc.upload_date)}
                </div>
            </div>
            <button class="action-btn" onclick="renameDocument('${doc.doc_id}', '${(doc.filename || '').replace(/'/g, "\\'")}')" title="Rename" style="flex-shrink: 0;">
                <i class="fas fa-edit"></i>
            </button>
            <button class="action-btn delete-btn" onclick="deleteDocument('${doc.doc_id}')" style="flex-shrink: 0;">
                <i class="fas fa-trash"></i>
            </button>
        </div>
    `).join('');
}

// ============ BREADCRUMB (FIXED - Proper Back Navigation) ============

function updateBreadcrumb(type) {
    const path = (type === 'upload') ? uploadPath : browsePath;
    const breadcrumbId = (type === 'upload') ? 'uploadBreadcrumb' : 'browseBreadcrumb';
    const breadcrumb = document.getElementById(breadcrumbId);
    if (!breadcrumb) return;
    
    // Root link - always visible, always goes to depth 0 (empty array)
    let html = `<span onclick="window.goToBreadcrumb('${type}', 0)" style="color: var(--primary-light); cursor: pointer; font-weight: 500; padding: 4px 8px; border-radius: 6px; display: inline-block;" onmouseover="this.style.background='rgba(99,102,241,0.15)'" onmouseout="this.style.background='transparent'">🏠 Root</span>`;
    
    // Each folder in path - click goes to that specific depth
    path.forEach((part, index) => {
        const depth = index + 1; // depth 1 = keep first folder, depth 2 = keep first two folders
        html += ` <span style="color: var(--text-secondary);">›</span> `;
        html += `<span onclick="window.goToBreadcrumb('${type}', ${depth})" style="color: var(--primary-light); cursor: pointer; font-weight: 500; padding: 4px 8px; border-radius: 6px; display: inline-block;" onmouseover="this.style.background='rgba(99,102,241,0.15)'" onmouseout="this.style.background='transparent'">📁 ${part}</span>`;
    });
    
    breadcrumb.innerHTML = html;
}

// Make goToBreadcrumb globally accessible for onclick handlers
window.goToBreadcrumb = function(type, depth) {
    console.log(`Breadcrumb clicked: type=${type}, depth=${depth}`);
    const currentPath = type === 'upload' ? uploadPath : browsePath;
    console.log(`Current path: ${JSON.stringify(currentPath)}, clicking depth: ${depth}`);
    goToPath(type, depth);
};

// ============ CREATE FOLDER ============

function createNewFolder(type) {
    const input = document.getElementById('newFolderName');
    const name = input.value.trim();
    if (!name) return;
    
    const path = type === 'upload' ? uploadPath : browsePath;
    
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
    
    showToast(`Folder "${name}" created!`);
}

// ============ RENAME ============

function renameFolder(oldName) {
    const newName = prompt('Enter new folder name:', oldName);
    if (!newName || newName === oldName) return;
    
    let current = folderStructure;
    for (let i = 0; i < browsePath.length; i++) {
        const part = browsePath[i];
        if (current[part] && current[part].subfolders) {
            current = current[part].subfolders;
        }
    }
    
    if (current[oldName]) {
        current[newName] = current[oldName];
        current[newName].name = newName;
        delete current[oldName];
        updateDocumentCategories(current[newName], [...browsePath, newName]);
    }
    
    renderBrowseView();
    loadStats();
    showToast(`Folder renamed to "${newName}"!`);
}

function updateDocumentCategories(folder, pathArray) {
    const newCategory = pathArray.join('/');
    (folder.files || []).forEach(doc => { doc.category = newCategory; });
    Object.entries(folder.subfolders || {}).forEach(([name, subfolder]) => {
        updateDocumentCategories(subfolder, [...pathArray, name]);
    });
}

function renameDocument(docId, oldFilename) {
    const newFilename = prompt('Enter new file name:', oldFilename);
    if (!newFilename || newFilename === oldFilename) return;
    
    const doc = allDocuments.find(d => d.doc_id === docId);
    if (doc) { doc.filename = newFilename; }
    
    updateFilenameInStructure(folderStructure, docId, newFilename);
    renderBrowseView();
    loadAllDocuments();
    showToast(`File renamed to "${newFilename}"!`);
}

function updateFilenameInStructure(structure, docId, newFilename) {
    Object.entries(structure).forEach(([key, value]) => {
        if (key === '_root_files' && Array.isArray(value)) {
            value.forEach(doc => { if (doc.doc_id === docId) doc.filename = newFilename; });
        } else if (value.files) {
            value.files.forEach(doc => { if (doc.doc_id === docId) doc.filename = newFilename; });
        }
        if (value.subfolders) { updateFilenameInStructure(value.subfolders, docId, newFilename); }
    });
}

// ============ DELETE ============

function deleteFolder(folderName) {
    if (!confirm(`Delete folder "${folderName}" and all its contents? This cannot be undone!`)) return;
    
    let current = folderStructure;
    for (let i = 0; i < browsePath.length; i++) {
        const part = browsePath[i];
        if (current[part] && current[part].subfolders) {
            current = current[part].subfolders;
        }
    }
    
    if (current[folderName]) {
        deleteDocumentsInFolder(current[folderName]);
        delete current[folderName];
    }
    
    if (browsePath.length > 0 && browsePath[browsePath.length - 1] === folderName) {
        browsePath.pop();
    }
    
    renderBrowseView();
    loadStats();
    showToast(`Folder "${folderName}" deleted!`);
}

function deleteDocumentsInFolder(folder) {
    (folder.files || []).forEach(doc => { deleteDocumentSilent(doc.doc_id); });
    Object.values(folder.subfolders || {}).forEach(subfolder => { deleteDocumentsInFolder(subfolder); });
}

async function deleteDocumentSilent(docId) {
    try { await fetch(`/admin/delete/${docId}`, { method: 'DELETE' }); } catch (e) {}
}

async function deleteDocument(docId) {
    if (!confirm('Delete this document permanently?')) return;
    try {
        const response = await fetch(`/admin/delete/${docId}`, { method: 'DELETE' });
        const data = await response.json();
        if (data.success) {
            loadFolderStructure(); loadAllDocuments(); loadStats();
            if (document.getElementById('browse-section')?.classList.contains('active')) renderBrowseView();
            showToast('Document deleted!');
        }
    } catch (error) { alert('Failed to delete'); }
}

// ============ ALL DOCUMENTS ============

async function loadAllDocuments() {
    const grid = document.getElementById('allDocumentsGrid');
    if (!grid) return;
    
    grid.innerHTML = '<div class="loading-state"><i class="fas fa-spinner fa-spin"></i><p>Loading...</p></div>';
    
    try {
        const response = await fetch('/admin/documents');
        const data = await response.json();
        
        if (data.documents && data.documents.length > 0) {
            allDocuments = data.documents;
            renderAllDocuments(allDocuments);
        } else {
            grid.innerHTML = `<div style="text-align: center; padding: 50px; color: var(--text-secondary);"><i class="fas fa-folder-open" style="font-size: 50px; opacity: 0.5;"></i><p>No documents uploaded yet</p></div>`;
        }
    } catch (error) {
        grid.innerHTML = '<div style="color: #ef4444; text-align: center;">Failed to load</div>';
    }
}

function renderAllDocuments(docs) {
    const grid = document.getElementById('allDocumentsGrid');
    if (!grid) return;
    
    if (docs.length === 0) {
        grid.innerHTML = '<div style="text-align: center; padding: 30px; color: var(--text-secondary);">No documents found.</div>';
        return;
    }
    
    grid.innerHTML = docs.map(doc => `
        <div class="file-card">
            <i class="fas ${getFileIcon(doc.file_type)} file-icon" style="color: ${getFolderColor(doc.file_type || '')};"></i>
            <div class="file-details">
                <div class="file-name">${doc.filename}</div>
                <div class="file-meta">${doc.category ? `📁 ${doc.category} • ` : ''}${doc.file_type ? doc.file_type.toUpperCase() : ''} • ${formatDate(doc.upload_date)}</div>
            </div>
            <button class="action-btn" onclick="renameDocument('${doc.doc_id}', '${(doc.filename || '').replace(/'/g, "\\'")}')" title="Rename"><i class="fas fa-edit"></i></button>
            <button class="action-btn delete-btn" onclick="deleteDocument('${doc.doc_id}')"><i class="fas fa-trash"></i></button>
        </div>
    `).join('');
}

function filterAllDocuments() {
    const search = document.getElementById('docSearch')?.value?.toLowerCase() || '';
    const filtered = allDocuments.filter(doc => (doc.filename || '').toLowerCase().includes(search) || (doc.category || '').toLowerCase().includes(search));
    renderAllDocuments(filtered);
}

// ============ UPLOAD ============

function setupUploadZone() {
    const uploadZone = document.getElementById('uploadZone');
    const fileInput = document.getElementById('fileInput');
    if (!uploadZone || !fileInput) return;
    
    uploadZone.addEventListener('click', () => fileInput.click());
    uploadZone.addEventListener('dragover', (e) => { e.preventDefault(); uploadZone.style.borderColor = '#6366f1'; });
    uploadZone.addEventListener('dragleave', () => { uploadZone.style.borderColor = '#334155'; });
    uploadZone.addEventListener('drop', (e) => { e.preventDefault(); uploadZone.style.borderColor = '#334155'; addFiles(Array.from(e.dataTransfer.files)); });
    fileInput.addEventListener('change', () => { addFiles(Array.from(fileInput.files)); fileInput.value = ''; });
}

function addFiles(files) { selectedFiles = [...selectedFiles, ...files]; renderFileList(); updateUploadButton(); }
function removeFile(index) { selectedFiles.splice(index, 1); renderFileList(); updateUploadButton(); }

function renderFileList() {
    const uploadList = document.getElementById('uploadList');
    if (!uploadList) return;
    if (selectedFiles.length === 0) { uploadList.innerHTML = ''; return; }
    uploadList.innerHTML = selectedFiles.map((file, index) => `
        <div class="file-item">
            <div class="file-info"><i class="fas fa-file-alt"></i><span>${file.name}</span><small>${formatFileSize(file.size)}</small></div>
            <button class="remove-file-btn" onclick="removeFile(${index})"><i class="fas fa-times"></i></button>
        </div>
    `).join('');
}

function updateUploadButton() {
    const uploadBtn = document.getElementById('uploadBtn');
    if (!uploadBtn) return;
    uploadBtn.disabled = selectedFiles.length === 0;
    const path = uploadPath.join(' / ') || 'Root';
    uploadBtn.innerHTML = selectedFiles.length === 0 ? '<i class="fas fa-upload"></i> Select Files' : `<i class="fas fa-upload"></i> Upload ${selectedFiles.length} File(s) to "${path}"`;
}

async function uploadFiles() {
    if (selectedFiles.length === 0) return;
    const uploadBtn = document.getElementById('uploadBtn');
    const progressDiv = document.getElementById('uploadProgress');
    const category = uploadPath.join('/');
    if (!uploadBtn) return;
    
    uploadBtn.disabled = true;
    uploadBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Uploading...';
    
    const formData = new FormData();
    selectedFiles.forEach(file => formData.append('files', file));
    if (category) formData.append('category', category);
    
    try {
        const response = await fetch('/admin/upload', { method: 'POST', body: formData });
        const data = await response.json();
        
        if (data.uploaded && data.uploaded.length > 0) {
            if (progressDiv) progressDiv.innerHTML = `<div style="color: #22c55e; margin-top: 16px; padding: 16px; background: rgba(34,197,94,0.1); border-radius: 12px;">✅ Uploaded ${data.uploaded.length} file(s) to "${category || 'Root'}"</div>`;
            selectedFiles = [];
            renderFileList();
            updateUploadButton();
            setTimeout(() => { loadFolderStructure(); loadStats(); }, 1000);
        }
        if (data.failed && data.failed.length > 0 && progressDiv) {
            progressDiv.innerHTML += `<div style="color: #ef4444; margin-top: 8px; font-size: 12px;">⚠️ ${data.failed.length} failed</div>`;
        }
    } catch (error) {
        if (progressDiv) progressDiv.innerHTML = `<div style="color: #ef4444;">❌ Upload failed</div>`;
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
        
        if (document.getElementById('statDocuments')) document.getElementById('statDocuments').textContent = data.total_documents || 0;
        if (document.getElementById('statChunks')) document.getElementById('statChunks').textContent = data.total_chunks || 0;
        
        let folderCount = 0;
        function countFolders(obj) {
            Object.keys(obj).forEach(key => {
                if (key !== '_root_files') { folderCount++; if (obj[key].subfolders) countFolders(obj[key].subfolders); }
            });
        }
        countFolders(folderStructure);
        if (document.getElementById('statFolders')) document.getElementById('statFolders').textContent = folderCount;
        if (document.getElementById('statStorage')) document.getElementById('statStorage').textContent = '~50 MB';
        
        renderFolderTree();
    } catch (error) { console.error('Stats error:', error); }
}

function renderFolderTree() {
    const container = document.getElementById('folderTreeView');
    if (!container) return;
    container.innerHTML = buildTreeHTML(folderStructure, 0);
    document.querySelectorAll('.tree-toggle').forEach(toggle => {
        toggle.addEventListener('click', function() {
            const children = this.parentElement.querySelector('.tree-children');
            if (children) { children.style.display = children.style.display === 'none' ? 'block' : 'none'; this.classList.toggle('open'); }
        });
    });
}

function buildTreeHTML(structure, level) {
    let html = '';
    Object.entries(structure).forEach(([name, folder]) => {
        if (name === '_root_files') return;
        const hasChildren = Object.keys(folder.subfolders || {}).length > 0;
        html += `<div class="tree-item" style="padding-left: ${level * 16}px;">`;
        html += hasChildren ? `<span class="tree-toggle open">▶</span>` : `<span style="width: 16px; display: inline-block;"></span>`;
        html += `<i class="fas fa-folder" style="color: ${getFolderColor(name)};"></i><span>${name}</span>`;
        html += `<span style="margin-left: auto; font-size: 11px; color: var(--text-secondary);">${(folder.files || []).length} files</span></div>`;
        if (hasChildren) { html += `<div class="tree-children">${buildTreeHTML(folder.subfolders, level + 1)}</div>`; }
    });
    return html;
}

// ============ UTILITIES ============

function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024; const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatDate(dateString) {
    try { return new Date(dateString).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }); }
    catch { return dateString; }
}

function getFileIcon(fileType) {
    const icons = { 'pdf': 'fa-file-pdf', 'docx': 'fa-file-word', 'txt': 'fa-file-alt', 'csv': 'fa-file-csv', 'xlsx': 'fa-file-excel', 'xls': 'fa-file-excel' };
    return icons[(fileType || '').toLowerCase()] || 'fa-file';
}

function getFolderColor(name) {
    const colors = ['#6366f1', '#06b6d4', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6'];
    let hash = 0;
    for (let i = 0; i < name.length; i++) { hash = name.charCodeAt(i) + ((hash << 5) - hash); }
    return colors[Math.abs(hash) % colors.length];
}

function showToast(message) {
    const toast = document.createElement('div');
    toast.style.cssText = `position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); background: var(--primary); color: white; padding: 12px 24px; border-radius: 25px; font-size: 14px; z-index: 1000; animation: fadeSlide 0.3s ease; box-shadow: 0 10px 30px rgba(0,0,0,0.3);`;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; toast.style.transition = 'opacity 0.3s'; setTimeout(() => toast.remove(), 300); }, 2000);
}