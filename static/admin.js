let selectedFiles = [];
let selectedCategory = '';
let allDocuments = [];
let folderStructure = {};

// Navigation state
let uploadPath = [];
let browsePath = [];

// ========== THEME TOGGLING ==========
function initTheme() {
    var savedTheme = localStorage.getItem('theme');
    var toggleBtn = document.getElementById('themeToggleBtn');
    if (savedTheme === 'dark') {
        document.body.classList.add('dark-theme');
        if (toggleBtn) {
            const icon = toggleBtn.querySelector('i');
            if (icon) {
                icon.classList.remove('fa-moon');
                icon.classList.add('fa-sun');
            }
        }
    }
}

function toggleTheme() {
    var toggleBtn = document.getElementById('themeToggleBtn');
    var icon = toggleBtn ? toggleBtn.querySelector('i') : null;
    if (document.body.classList.contains('dark-theme')) {
        document.body.classList.remove('dark-theme');
        localStorage.setItem('theme', 'light');
        if (icon) {
            icon.classList.remove('fa-sun');
            icon.classList.add('fa-moon');
        }
    } else {
        document.body.classList.add('dark-theme');
        localStorage.setItem('theme', 'dark');
        if (icon) {
            icon.classList.remove('fa-moon');
            icon.classList.add('fa-sun');
        }
    }
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    initTheme();
    setupUploadZone();
    setupCategorySelector();
    setupNavigationListeners();
    loadFolderStructure();
    loadStats();

    // Restore last active section or check URL hash
    const hash = window.location.hash.replace('#', '');
    if (hash && ['upload', 'documents', 'browse', 'stats', 'sync'].includes(hash)) {
        navigateToSection(hash, false);
    } else {
        const savedSection = sessionStorage.getItem('adminCurrentSection');
        if (savedSection && ['upload', 'documents', 'browse', 'stats', 'sync'].includes(savedSection)) {
            navigateToSection(savedSection, false);
        }
    }
});

// ============ FIXED NAVIGATION WITH BROWSER HISTORY ============

function setupNavigationListeners() {
    // Add click listeners to all nav items
    document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', function (e) {
            e.preventDefault();
            const sectionName = this.getAttribute('href').replace('#', '');
            navigateToSection(sectionName, true);
        });
    });

    // Listen for browser back/forward buttons
    window.addEventListener('popstate', function (event) {
        if (event.state && event.state.section) {
            navigateToSection(event.state.section, false);
        } else {
            // If no state, go to default (upload)
            navigateToSection('upload', false);
        }
    });
}

function navigateToSection(sectionName, addToHistory) {
    // Default to true if not specified
    if (addToHistory === undefined) addToHistory = true;

    // Update nav active state
    document.querySelectorAll('.nav-item').forEach(item => {
        item.classList.remove('active');
        if (item.getAttribute('href') === '#' + sectionName) {
            item.classList.add('active');
        }
    });

    // Show the correct section
    document.querySelectorAll('.content-section').forEach(section => {
        section.classList.remove('active');
    });

    const targetSection = document.getElementById(sectionName + '-section');
    if (targetSection) {
        targetSection.classList.add('active');
    }

    // Update browser history
    if (addToHistory) {
        const state = { section: sectionName };
        const url = '#' + sectionName;
        history.pushState(state, '', url);
    } else {
        // Replace current state without adding new entry
        const state = { section: sectionName };
        const url = '#' + sectionName;
        history.replaceState(state, '', url);
    }

    // Save current section
    sessionStorage.setItem('adminCurrentSection', sectionName);

    // Load data for the section
    if (sectionName === 'documents') loadDocuments();
    if (sectionName === 'browse') {
        loadFolderStructure().then(() => renderBrowseView());
    }
    if (sectionName === 'stats') loadStats();
    if (sectionName === 'sync') loadSyncStatus();
}

// Keep old showSection for backward compatibility
function showSection(sectionName) {
    navigateToSection(sectionName, true);
}

// ============ FOLDER STRUCTURE ============

async function loadFolderStructure() {
    try {
        const response = await fetch('/admin/documents');
        const data = await response.json();
        if (data.documents) {
            allDocuments = data.documents;
            buildFolderStructure();
            updateQuickFolders();
            updateCategoryFilter();
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
            if (!folderStructure['_root_files']) folderStructure['_root_files'] = [];
            folderStructure['_root_files'].push(doc);
            return;
        }
        const parts = path.split('/').filter(p => p.trim() !== '');
        let current = folderStructure;
        parts.forEach((part, index) => {
            if (!current[part]) {
                current[part] = { name: part, files: [], subfolders: {}, count: 0, totalItems: 0 };
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
        if (folder.subfolders && Object.keys(folder.subfolders).length > 0) subTotal += countFolderItems(folder.subfolders);
        folder.totalItems = subTotal;
        total += subTotal;
    });
    return total;
}

// ============ NAVIGATION (BREADCRUMB) ============

function goToPath(type, depth) {
    if (type === 'upload') {
        uploadPath = (depth === 0) ? [] : uploadPath.slice(0, depth);
        renderUploadFolders();
    } else if (type === 'browse') {
        browsePath = (depth === 0) ? [] : browsePath.slice(0, depth);
        renderBrowseView();
    }
}

function enterFolder(type, folderName) {
    if (type === 'upload') { uploadPath.push(folderName); renderUploadFolders(); }
    else if (type === 'browse') { browsePath.push(folderName); renderBrowseView(); }
}

// Make functions globally accessible for onclick handlers
window.goToPath = goToPath;
window.enterFolder = enterFolder;

// ============ CATEGORY MANAGEMENT ============

function setupCategorySelector() {
    document.querySelectorAll('.category-tag').forEach(tag => {
        tag.addEventListener('click', function () {
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
    const existing = document.querySelector(`.category-tag[data-category="${category}"]`);
    if (existing) { existing.click(); input.value = ''; return; }
    const selector = document.getElementById('categorySelector');
    const tag = document.createElement('span');
    tag.className = 'category-tag';
    tag.dataset.category = category;
    tag.textContent = '📁 ' + category;
    tag.addEventListener('click', function () {
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

// ============ UPLOAD SECTION ============

function renderUploadFolders() {
    const container = document.getElementById('uploadFolders');
    if (!container) return;
    let current = folderStructure;
    uploadPath.forEach(part => { if (current[part]) current = current[part].subfolders; });
    updateBreadcrumb('upload');
    const folders = Object.entries(current).filter(([key]) => key !== '_root_files');
    if (folders.length === 0) {
        container.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:30px;color:var(--text-secondary);"><i class="fas fa-folder-open" style="font-size:40px;opacity:0.3;margin-bottom:10px;display:block;"></i><p>This folder is empty</p><p style="font-size:11px;">Create a subfolder or upload files here</p></div>`;
    } else {
        container.innerHTML = folders.map(([name, folder]) => `
            <div class="folder-card" onclick="window.enterFolder('upload', '${name.replace(/'/g, "\\'")}')">
                <i class="fas fa-folder folder-icon" style="color:${getFolderColor(name)};"></i>
                <div class="folder-name">${name}</div>
                <div class="folder-info">${folder.totalItems || 0} items</div>
                ${folder.totalItems > 0 ? `<span class="folder-badge">${folder.totalItems}</span>` : ''}
            </div>`).join('');
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
        if (current[part] && current[part].subfolders) current = current[part].subfolders;
        else { current = {}; break; }
    }
    const folders = Object.entries(current).filter(([key]) => key !== '_root_files');
    if (folders.length === 0) {
        container.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:30px;color:var(--text-secondary);"><i class="fas fa-folder-open" style="font-size:40px;opacity:0.3;margin-bottom:10px;display:block;"></i><p>No subfolders here</p></div>`;
    } else {
        container.innerHTML = folders.map(([name, folder]) => `
            <div class="folder-card">
                <i class="fas fa-folder folder-icon" style="color:${getFolderColor(name)};"></i>
                <div class="folder-name">${name}</div>
                <div class="folder-info">${Object.keys(folder.subfolders || {}).length} subfolders • ${folder.totalItems || 0} files</div>
                <span class="folder-badge">${folder.totalItems || 0}</span>
                <div style="display:flex;gap:6px;margin-top:8px;">
                    <button class="action-btn" onclick="event.stopPropagation();window.enterFolder('browse','${name.replace(/'/g, "\\'")}')" style="flex:1;"><i class="fas fa-arrow-right"></i> Open</button>
                    <button class="action-btn" onclick="event.stopPropagation();renameFolder('${name.replace(/'/g, "\\'")}')" title="Rename"><i class="fas fa-edit"></i></button>
                    <button class="action-btn delete-btn" onclick="event.stopPropagation();deleteFolder('${name.replace(/'/g, "\\'")}')" title="Delete"><i class="fas fa-trash"></i></button>
                </div>
            </div>`).join('');
    }
}

function getFilesRecursively(folder) {
    let files = [...(folder.files || [])];
    if (folder.subfolders) {
        Object.values(folder.subfolders).forEach(sub => {
            files = files.concat(getFilesRecursively(sub));
        });
    }
    return files;
}

function renderBrowseFiles() {
    const container = document.getElementById('browseFiles');
    if (!container) return;
    let files = [];
    let isRecursive = false;
    
    if (browsePath.length === 0) { 
        if (folderStructure['_root_files']) files = folderStructure['_root_files']; 
    } else {
        let current = folderStructure;
        for (let i = 0; i < browsePath.length; i++) {
            const part = browsePath[i];
            if (current[part]) {
                if (i === browsePath.length - 1) {
                    files = current[part].files || [];
                    if (files.length === 0 && (current[part].totalItems || 0) > 0) {
                        files = getFilesRecursively(current[part]);
                        isRecursive = true;
                    }
                }
                else current = current[part].subfolders || {};
            } else { files = []; break; }
        }
    }
    
    // Update files header dynamically
    const heading = document.querySelector('#browse-section h3');
    if (heading) {
        if (isRecursive) {
            heading.innerHTML = `<i class="fas fa-file-alt"></i> Files inside subfolders`;
        } else {
            heading.innerHTML = `<i class="fas fa-file-alt"></i> Files in this folder`;
        }
    }

    if (files.length === 0) {
        container.innerHTML = `<div style="text-align:center;padding:30px;color:var(--text-secondary);"><i class="fas fa-file-alt" style="font-size:30px;opacity:0.3;margin-bottom:8px;display:block;"></i><p style="font-size:13px;">No files in this folder</p></div>`;
        return;
    }
    
    container.innerHTML = files.map(doc => `
        <div class="file-card">
            <i class="fas ${getFileIcon(doc.file_type)} file-icon" style="color:${getFolderColor(doc.file_type || '')};"></i>
            <div class="file-details">
                <div class="file-name">${doc.filename}</div>
                <div class="file-meta">
                    ${doc.file_type ? doc.file_type.toUpperCase() : ''} • ${formatDate(doc.upload_date)}
                    ${isRecursive && doc.category ? ` • 📁 ${doc.category}` : ''}
                </div>
            </div>
            <button class="action-btn rename-btn" onclick="openRenameModal('${doc.doc_id}','${(doc.filename || '').replace(/'/g, "\\'")}')" title="Rename"><i class="fas fa-pen"></i></button>
            <button class="action-btn delete-btn" onclick="deleteDocument('${doc.doc_id}')"><i class="fas fa-trash"></i></button>
        </div>`).join('');
}

// ============ BREADCRUMB ============

function updateBreadcrumb(type) {
    const path = (type === 'upload') ? uploadPath : browsePath;
    const breadcrumbId = (type === 'upload') ? 'uploadBreadcrumb' : 'browseBreadcrumb';
    const breadcrumb = document.getElementById(breadcrumbId);
    if (!breadcrumb) return;
    let html = `<span onclick="window.goToPath('${type}',0)" style="color:var(--primary-light);cursor:pointer;font-weight:500;padding:4px 8px;border-radius:6px;display:inline-block;" onmouseover="this.style.background='rgba(99,102,241,0.15)'" onmouseout="this.style.background='transparent'">🏠 Root</span>`;
    path.forEach((part, index) => {
        html += ` <span style="color:var(--text-secondary);">›</span> `;
        html += `<span onclick="window.goToPath('${type}',${index + 1})" style="color:var(--primary-light);cursor:pointer;font-weight:500;padding:4px 8px;border-radius:6px;display:inline-block;" onmouseover="this.style.background='rgba(99,102,241,0.15)'" onmouseout="this.style.background='transparent'">📁 ${part}</span>`;
    });
    breadcrumb.innerHTML = html;
}

// ============ CREATE FOLDER ============

function createNewFolder(type) {
    const input = document.getElementById('newFolderName');
    const name = input.value.trim();
    if (!name) return;
    const path = type === 'upload' ? uploadPath : browsePath;
    let current = folderStructure;
    path.forEach(part => {
        if (!current[part]) current[part] = { name: part, files: [], subfolders: {}, count: 0, totalItems: 0 };
        current = current[part].subfolders;
    });
    if (!current[name]) current[name] = { name: name, files: [], subfolders: {}, count: 0, totalItems: 0 };
    input.value = '';
    if (type === 'upload') renderUploadFolders();
    else renderBrowseView();
    showToast(`Folder "${name}" created!`);
}

// ============ RENAME ============

let _renameDocId = null;

function openRenameModal(docId, currentName) {
    _renameDocId = docId;
    const input = document.getElementById('renameInput');
    const errEl = document.getElementById('renameError');
    input.value = currentName;
    errEl.textContent = '';
    document.getElementById('renameModal').classList.add('active');
    setTimeout(() => { input.focus(); input.select(); }, 80);
}

function closeRenameModal(event) {
    if (event && event.target !== document.getElementById('renameModal')) return;
    document.getElementById('renameModal').classList.remove('active');
    _renameDocId = null;
}

async function confirmRename() {
    if (!_renameDocId) return;
    const input = document.getElementById('renameInput');
    const errEl = document.getElementById('renameError');
    const btn = document.getElementById('renameConfirmBtn');
    const newName = input.value.trim();
    if (!newName) { errEl.textContent = 'Please enter a filename.'; input.focus(); return; }
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Renaming...';
    errEl.textContent = '';
    try {
        const response = await fetch(`/admin/rename/${_renameDocId}`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ new_name: newName })
        });
        const data = await response.json();
        if (data.success) {
            const doc = allDocuments.find(d => d.doc_id === _renameDocId);
            if (doc) doc.filename = data.new_name;
            document.getElementById('renameModal').classList.remove('active');
            _renameDocId = null;
            if (document.getElementById('documents-section')?.classList.contains('active')) filterDocuments();
            if (document.getElementById('browse-section')?.classList.contains('active')) renderBrowseView();
        } else { errEl.textContent = data.message || 'Rename failed.'; }
    } catch (error) { errEl.textContent = 'Network error.'; }
    finally { btn.disabled = false; btn.innerHTML = '<i class="fas fa-check"></i> Rename'; }
}

function renameFolder(oldName) {
    const newName = prompt('Enter new folder name:', oldName);
    if (!newName || newName === oldName) return;
    let current = folderStructure;
    for (let i = 0; i < browsePath.length; i++) {
        const part = browsePath[i];
        if (current[part] && current[part].subfolders) current = current[part].subfolders;
    }
    if (current[oldName]) {
        current[newName] = current[oldName]; current[newName].name = newName; delete current[oldName];
        updateDocumentCategories(current[newName], [...browsePath, newName]);
    }
    renderBrowseView(); loadStats(); showToast(`Folder renamed to "${newName}"!`);
}

function updateDocumentCategories(folder, pathArray) {
    const newCategory = pathArray.join('/');
    (folder.files || []).forEach(doc => { doc.category = newCategory; });
    Object.entries(folder.subfolders || {}).forEach(([name, subfolder]) => { updateDocumentCategories(subfolder, [...pathArray, name]); });
}

// ============ DELETE ============

function deleteFolder(folderName) {
    if (!confirm(`Delete folder "${folderName}" and all its contents?`)) return;
    let current = folderStructure;
    for (let i = 0; i < browsePath.length; i++) {
        const part = browsePath[i];
        if (current[part] && current[part].subfolders) current = current[part].subfolders;
    }
    if (current[folderName]) { deleteDocumentsInFolder(current[folderName]); delete current[folderName]; }
    if (browsePath.length > 0 && browsePath[browsePath.length - 1] === folderName) browsePath.pop();
    renderBrowseView(); loadStats(); showToast(`Folder "${folderName}" deleted!`);
}

function deleteDocumentsInFolder(folder) {
    (folder.files || []).forEach(doc => { deleteDocumentSilent(doc.doc_id); });
    Object.values(folder.subfolders || {}).forEach(subfolder => { deleteDocumentsInFolder(subfolder); });
}

async function deleteDocumentSilent(docId) { try { await fetch(`/admin/delete/${docId}`, { method: 'DELETE' }); } catch (e) { } }

async function deleteDocument(docId) {
    if (!confirm('Delete this document permanently?')) return;
    try {
        const response = await fetch(`/admin/delete/${docId}`, { method: 'DELETE' });
        const data = await response.json();
        if (data.success) { loadFolderStructure(); loadDocuments(); loadStats(); if (document.getElementById('browse-section')?.classList.contains('active')) renderBrowseView(); showToast('Document deleted!'); }
    } catch (error) { alert('Failed to delete'); }
}

// ============ DOCUMENTS ============

async function loadDocuments() {
    const grid = document.getElementById('documentsGrid');
    if (!grid) return;
    grid.innerHTML = '<div class="loading-state"><i class="fas fa-spinner fa-spin"></i><p>Loading...</p></div>';
    try {
        const response = await fetch('/admin/documents');
        const data = await response.json();
        if (data.documents && data.documents.length > 0) {
            allDocuments = data.documents;
            updateCategoryFilter();
            updateQuickFolders();
            filterDocuments();
        } else {
            grid.innerHTML = `<div style="text-align:center;padding:50px;color:var(--text-secondary);"><i class="fas fa-folder-open" style="font-size:50px;opacity:0.5;"></i><p>No documents uploaded yet</p></div>`;
            document.getElementById('quickFolders').innerHTML = '';
        }
    } catch (error) { grid.innerHTML = '<div style="color:#ef4444;text-align:center;">Failed to load</div>'; }
}

function updateCategoryFilter() {
    const select = document.getElementById('categoryFilter');
    const categories = new Set();
    allDocuments.forEach(doc => { if (doc.category) categories.add(doc.category); });
    select.innerHTML = '<option value="">All Categories</option>';
    categories.forEach(cat => { select.innerHTML += `<option value="${cat}">${cat}</option>`; });
}

function updateQuickFolders() {
    const quickFolders = document.getElementById('quickFolders');
    const categoryCount = {};
    allDocuments.forEach(doc => { const cat = doc.category || 'Uncategorized'; categoryCount[cat] = (categoryCount[cat] || 0) + 1; });
    quickFolders.innerHTML = Object.entries(categoryCount).map(([cat, count]) => `
        <div class="quick-folder" onclick="filterByCategory('${cat}')">
            <i class="fas fa-folder${cat === 'Uncategorized' ? '' : '-open'}" style="color:${getFolderColor(cat)};"></i>
            <span>${cat}</span><span class="count">${count}</span>
        </div>`).join('');
}

function renderDocumentList(docs) {
    const grid = document.getElementById('documentsGrid');
    if (docs.length === 0) { grid.innerHTML = '<div style="text-align:center;padding:30px;color:var(--text-secondary);">No documents match.</div>'; return; }
    grid.innerHTML = docs.map(doc => `
        <div class="document-card">
            <div class="doc-info">
                <div class="doc-icon"><i class="fas ${getFileIcon(doc.file_type)}" style="color:${getFolderColor(doc.category || '')};"></i></div>
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
                <button class="action-btn rename-btn" onclick="openRenameModal('${doc.doc_id}','${doc.filename.replace(/'/g, "\\'")}')" title="Rename"><i class="fas fa-pen"></i> Rename</button>
                <button class="action-btn delete-btn" onclick="deleteDocument('${doc.doc_id}')"><i class="fas fa-trash"></i> Delete</button>
            </div>
        </div>`).join('');
}

function filterDocuments() {
    const searchTerm = document.getElementById('docSearch').value.toLowerCase();
    const category = document.getElementById('categoryFilter').value;
    const sortBy = document.getElementById('sortBy')?.value || 'category';
    
    let filtered = [...allDocuments];
    
    // Apply filters
    if (searchTerm) {
        filtered = filtered.filter(doc => 
            doc.filename.toLowerCase().includes(searchTerm) || 
            (doc.category && doc.category.toLowerCase().includes(searchTerm))
        );
    }
    if (category) {
        filtered = filtered.filter(doc => doc.category === category);
    }
    
    // Apply sorting
    filtered.sort((a, b) => {
        if (sortBy === 'category') {
            const catA = a.category || 'Uncategorized';
            const catB = b.category || 'Uncategorized';
            if (catA !== catB) {
                return catA.localeCompare(catB);
            }
            return a.filename.localeCompare(b.filename);
        } else if (sortBy === 'nameAsc') {
            return a.filename.localeCompare(b.filename);
        } else if (sortBy === 'nameDesc') {
            return b.filename.localeCompare(a.filename);
        } else if (sortBy === 'dateDesc') {
            const dateA = new Date(a.upload_date || 0);
            const dateB = new Date(b.upload_date || 0);
            return dateB - dateA;
        } else if (sortBy === 'dateAsc') {
            const dateA = new Date(a.upload_date || 0);
            const dateB = new Date(b.upload_date || 0);
            return dateA - dateB;
        }
        return 0;
    });
    
    renderDocumentList(filtered);
}

function filterByCategory(category) { 
    document.getElementById('categoryFilter').value = category; 
    filterDocuments(); 
}

// ============ UPLOAD ============

function setupUploadZone() {
    const uploadZone = document.getElementById('uploadZone');
    const fileInput = document.getElementById('fileInput');
    if (!uploadZone || !fileInput) return;
    uploadZone.addEventListener('click', () => fileInput.click());
    uploadZone.addEventListener('dragover', (e) => { e.preventDefault(); uploadZone.style.borderColor = '#6366f1'; uploadZone.style.background = 'rgba(99,102,241,0.08)'; });
    uploadZone.addEventListener('dragleave', () => { uploadZone.style.borderColor = '#334155'; uploadZone.style.background = '#334155'; });
    uploadZone.addEventListener('drop', (e) => { e.preventDefault(); uploadZone.style.borderColor = '#334155'; uploadZone.style.background = '#334155'; addFiles(Array.from(e.dataTransfer.files)); });
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
        </div>`).join('');
}

function updateUploadButton() {
    const uploadBtn = document.getElementById('uploadBtn');
    uploadBtn.disabled = selectedFiles.length === 0;
    const catText = selectedCategory || 'All Documents';
    uploadBtn.innerHTML = selectedFiles.length === 0 ? '<i class="fas fa-upload"></i> Select Files to Upload' : `<i class="fas fa-upload"></i> Upload ${selectedFiles.length} File(s) to ${catText}`;
}

async function uploadFiles() {
    if (selectedFiles.length === 0) return;
    const uploadBtn = document.getElementById('uploadBtn');
    const progressDiv = document.getElementById('uploadProgress');
    uploadBtn.disabled = true;
    uploadBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Uploading...';
    progressDiv.innerHTML = '<div class="loading-state"><i class="fas fa-spinner fa-spin"></i><p>Processing...</p></div>';
    const formData = new FormData();
    selectedFiles.forEach(file => formData.append('files', file));
    if (selectedCategory) formData.append('category', selectedCategory);
    try {
        const response = await fetch('/admin/upload', { method: 'POST', body: formData });
        const data = await response.json();
        if (data.uploaded && data.uploaded.length > 0) {
            progressDiv.innerHTML = `<div style="color:#22c55e;margin-top:16px;padding:16px;background:rgba(34,197,94,0.1);border-radius:12px;"><h3 style="margin-bottom:8px;"><i class="fas fa-check-circle"></i> Upload Successful!</h3>${data.uploaded.map(file => `<p style="margin:4px 0;font-size:13px;">✅ ${file.name} → ${selectedCategory || 'Root'} (${file.chunks} chunks)</p>`).join('')}</div>`;
            selectedFiles = []; renderFileList(); updateUploadButton();
            setTimeout(() => { loadFolderStructure(); loadStats(); }, 1000);
        }
        if (data.failed && data.failed.length > 0) {
            progressDiv.innerHTML += `<div style="color:#ef4444;margin-top:10px;padding:12px;background:rgba(239,68,68,0.1);border-radius:10px;"><h4 style="margin-bottom:6px;">⚠️ Failed:</h4>${data.failed.map(file => `<p style="margin:3px 0;font-size:12px;">❌ ${file.name}: ${file.reason}</p>`).join('')}</div>`;
        }
    } catch (error) { progressDiv.innerHTML = `<div style="color:#ef4444;padding:12px;">❌ Upload failed</div>`; }
    finally { uploadBtn.disabled = false; uploadBtn.innerHTML = '<i class="fas fa-upload"></i> Upload to Database'; }
}

// ============ STATISTICS ============

async function loadStats() {
    try {
        const response = await fetch('/admin/stats');
        const data = await response.json();
        if (document.getElementById('statDocuments')) document.getElementById('statDocuments').textContent = data.total_documents || 0;
        if (document.getElementById('statChunks')) document.getElementById('statChunks').textContent = data.total_chunks || 0;
        let folderCount = 0;
        function countFolders(obj) { Object.keys(obj).forEach(key => { if (key !== '_root_files') { folderCount++; if (obj[key].subfolders) countFolders(obj[key].subfolders); } }); }
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
        toggle.addEventListener('click', function () {
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
        html += `<div class="tree-item" style="padding-left:${level * 16}px;">`;
        html += hasChildren ? `<span class="tree-toggle open">▶</span>` : `<span style="width:16px;display:inline-block;"></span>`;
        html += `<i class="fas fa-folder" style="color:${getFolderColor(name)};"></i><span>${name}</span>`;
        html += `<span style="margin-left:auto;font-size:11px;color:var(--text-secondary);">${(folder.files || []).length} files</span></div>`;
        if (hasChildren) html += `<div class="tree-children">${buildTreeHTML(folder.subfolders, level + 1)}</div>`;
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
    try { return new Date(dateString).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
    catch { return dateString; }
}

function getFileIcon(fileType) {
    const icons = { 'pdf': 'fa-file-pdf', 'pptx': 'fa-file-powerpoint', 'ppt': 'fa-file-powerpoint', 'docx': 'fa-file-word', 'txt': 'fa-file-alt', 'csv': 'fa-file-csv', 'xlsx': 'fa-file-excel', 'xls': 'fa-file-excel' };
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
    toast.style.cssText = `position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:var(--primary);color:white;padding:12px 24px;border-radius:25px;font-size:14px;z-index:1000;animation:fadeSlide 0.3s ease;box-shadow:0 10px 30px rgba(0,0,0,0.3);`;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; toast.style.transition = 'opacity 0.3s'; setTimeout(() => toast.remove(), 300); }, 2000);
}

// ============ WEBSITE SYNC SECTION ============

let syncPollingInterval = null;

function loadSyncStatus() {
    fetch('/admin/sync-status')
        .then(res => res.json())
        .then(data => {
            const statusText = document.getElementById('syncStatusText');
            const countText = document.getElementById('syncCountText');
            const startBtn = document.getElementById('startSyncBtn');
            
            if (countText) countText.innerText = data.crawler_chunks;
            
            if (statusText && startBtn) {
                if (data.sync_in_progress) {
                    statusText.innerText = "Sync in progress...";
                    statusText.style.color = "#6366f1";
                    startBtn.disabled = true;
                    startBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Syncing...';
                    
                    // Start polling if not already
                    if (!syncPollingInterval) {
                        syncPollingInterval = setInterval(loadSyncStatus, 5000);
                    }
                } else {
                    statusText.innerText = "Idle";
                    statusText.style.color = "var(--text-secondary)";
                    startBtn.disabled = false;
                    startBtn.innerHTML = '<i class="fas fa-sync-alt"></i> Sync Now';
                    
                    // Stop polling
                    if (syncPollingInterval) {
                        clearInterval(syncPollingInterval);
                        syncPollingInterval = null;
                    }
                }
            }
        })
        .catch(err => console.error("Error loading sync status:", err));
}

function triggerWebsiteSync() {
    const startBtn = document.getElementById('startSyncBtn');
    if (startBtn) {
        startBtn.disabled = true;
        startBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Starting...';
    }
    
    fetch('/admin/sync-website', { method: 'POST' })
        .then(res => res.json())
        .then(data => {
            if (data.success) {
                showToast("Background website sync started!");
                loadSyncStatus();
            } else {
                showToast("Error: " + data.message);
                loadSyncStatus();
            }
        })
        .catch(err => {
            console.error("Error triggering website sync:", err);
            showToast("Failed to start sync.");
            loadSyncStatus();
        });
}

// Call on load sync section
document.addEventListener('DOMContentLoaded', () => {
    // Add to initial loaders
    loadSyncStatus();
});