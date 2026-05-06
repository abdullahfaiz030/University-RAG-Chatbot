import os
import warnings
warnings.filterwarnings('ignore')
os.environ['HF_HUB_DISABLE_SYMLINKS_WARNING'] = '1'
os.environ['CHROMADB_TELEMETRY'] = 'False'
os.environ['TOKENIZERS_PARALLELISM'] = 'false'

from flask import Flask, render_template, request, jsonify, session, redirect, url_for
from werkzeug.utils import secure_filename
from werkzeug.security import generate_password_hash, check_password_hash
from chromadb import Client
from chromadb.config import Settings
from sentence_transformers import SentenceTransformer
from groq import Groq
import PyPDF2
import docx
import pandas as pd
from dotenv import load_dotenv
from functools import wraps
import json
from datetime import timedelta
import traceback
import time
import re

load_dotenv()

# ========== HUGGING FACE SECRETS SUPPORT ==========
def load_hf_secrets():
    """Load secrets from Hugging Face Spaces"""
    # Method 1: /run/secrets directory
    secrets_dir = '/run/secrets'
    if os.path.exists(secrets_dir):
        for secret_name in os.listdir(secrets_dir):
            secret_path = os.path.join(secrets_dir, secret_name)
            try:
                with open(secret_path, 'r') as f:
                    os.environ[secret_name] = f.read().strip()
                print(f"✅ Loaded secret: {secret_name}")
            except Exception as e:
                print(f"⚠️ Could not load {secret_name}: {e}")
    
    # Method 2: Individual secret files
    for secret_name in ['GROQ_API_KEY', 'SECRET_KEY', 'ADMIN_USERNAME', 'ADMIN_PASSWORD']:
        if not os.environ.get(secret_name):
            paths = [
                f'/etc/secrets/{secret_name}',
                f'/secrets/{secret_name}',
                f'/run/secrets/{secret_name}'
            ]
            for path in paths:
                if os.path.exists(path):
                    try:
                        with open(path, 'r') as f:
                            os.environ[secret_name] = f.read().strip()
                        print(f"✅ Loaded secret from file: {secret_name}")
                        break
                    except:
                        pass

load_hf_secrets()

# Debug: Print if API key is set
groq_key = os.environ.get('GROQ_API_KEY', 'NOT SET')
print(f"🔑 GROQ_API_KEY: {'SET (starts with ' + groq_key[:10] + '...)' if groq_key != 'NOT SET' else 'NOT SET'}")
# ========== END HUGGING FACE SECRETS ==========

app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = 32 * 1024 * 1024
app.config['UPLOAD_FOLDER'] = 'uploads'
app.secret_key = os.getenv('SECRET_KEY', 'your-secret-key-change-this')
app.permanent_session_lifetime = timedelta(hours=24)

ADMIN_USERNAME = os.getenv('ADMIN_USERNAME', 'admin')
ADMIN_PASSWORD_HASH = generate_password_hash(os.getenv('ADMIN_PASSWORD', 'Admin@123'))

os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)

print("\n" + "="*60)
print("🔄 INITIALIZING...")
print("="*60)

# Embedding model
try:
    embedding_model = SentenceTransformer('all-MiniLM-L6-v2')
    print("✅ Embedding model loaded")
except:
    embedding_model = None
    print("❌ Embedding failed")

# ChromaDB
try:
    chroma_client = Client(Settings(
        persist_directory="chroma_db",
        anonymized_telemetry=False,
        is_persistent=True
    ))
    print("✅ ChromaDB initialized")
except:
    chroma_client = None
    print("❌ ChromaDB failed")

document_collection = None
metadata_collection = None

if chroma_client:
    try:
        document_collection = chroma_client.get_or_create_collection("documents")
        print(f"✅ Document collection ready ({document_collection.count()} chunks)")
    except Exception as e:
        print(f"❌ Collection error: {e}")
        document_collection = None
    
    try:
        metadata_collection = chroma_client.get_or_create_collection("document_metadata")
        print("✅ Metadata collection ready")
    except:
        metadata_collection = None

# Groq
groq_api_key = os.getenv('GROQ_API_KEY')
groq_client = None
groq_connected = False

if groq_api_key:
    try:
        groq_client = Groq(api_key=groq_api_key)
        test = groq_client.chat.completions.create(
            model="llama-3.1-8b-instant",
            messages=[{"role": "user", "content": "hi"}],
            max_tokens=5
        )
        groq_connected = True
        print("✅ Groq API connected")
    except:
        try:
            groq_client = Groq(api_key=groq_api_key)
        except:
            groq_client = None
        print("⚠️ Groq will try at runtime")
else:
    print("❌ No Groq API key found in environment")

print("="*60 + "\n")

def admin_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if 'admin_logged_in' not in session:
            return redirect(url_for('admin_login_page'))
        return f(*args, **kwargs)
    return decorated_function

# ============== PDF EXTRACTION ==============

def extract_text_from_pdf(file_path):
    text = ""
    try:
        with open(file_path, 'rb') as file:
            reader = PyPDF2.PdfReader(file)
            for page in reader.pages:
                page_text = page.extract_text()
                if page_text and len(page_text.strip()) > 10:
                    text += page_text + "\n"
    except:
        pass
    
    if len(text.strip()) < 100:
        try:
            from pdf2image import convert_from_path
            import pytesseract
            images = convert_from_path(file_path, dpi=150)
            ocr_text = ""
            for img in images:
                page_text = pytesseract.image_to_string(img)
                if page_text.strip():
                    ocr_text += page_text + "\n"
            if len(ocr_text) > len(text):
                text = ocr_text
        except:
            pass
    
    return text

def extract_text_from_docx(file_path):
    try:
        doc = docx.Document(file_path)
        return "\n".join([p.text for p in doc.paragraphs if p.text.strip()])
    except:
        return ""

def extract_text_from_txt(file_path):
    for enc in ['utf-8', 'latin-1', 'cp1252']:
        try:
            with open(file_path, 'r', encoding=enc) as f:
                return f.read()
        except:
            continue
    return ""

def clean_text(text):
    text = re.sub(r'\n\s*\n\s*\n+', '\n\n', text)
    text = re.sub(r'[ \t]+', ' ', text)
    text = re.sub(r'image\[\[.*?\]\]', '', text)
    text = re.sub(r'\b\d{1,2}/\d{1,2}/\d{2,4}\b', '', text)
    text = re.sub(r'<center>.*?</center>', '', text, flags=re.DOTALL)
    return text.strip()

def chunk_text(text, size=500, overlap=50):
    paragraphs = re.split(r'\n\s*\n', text)
    chunks = []
    current = ""
    
    for para in paragraphs:
        para = para.strip()
        if not para or len(para) < 20:
            continue
        if len(current) + len(para) < size:
            current += para + "\n\n"
        else:
            if current.strip():
                chunks.append(current.strip())
            current = para + "\n\n"
    
    if current.strip():
        chunks.append(current.strip())
    
    return chunks if chunks else [text[:size]]

# ==================== ROUTES ====================

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/admin')
def admin_login_page():
    if 'admin_logged_in' in session:
        return redirect(url_for('admin_panel'))
    return render_template('admin_login.html')

@app.route('/admin/login', methods=['POST'])
def admin_login():
    data = request.json
    if data.get('username') == ADMIN_USERNAME and check_password_hash(ADMIN_PASSWORD_HASH, data.get('password', '')):
        session.permanent = True
        session['admin_logged_in'] = True
        return jsonify({'success': True})
    return jsonify({'success': False, 'message': 'Invalid credentials'}), 401

@app.route('/admin/logout')
def admin_logout():
    session.pop('admin_logged_in', None)
    return redirect(url_for('admin_login_page'))

@app.route('/admin/panel')
@admin_required
def admin_panel():
    return render_template('admin.html')

@app.route('/admin/upload', methods=['POST'])
@admin_required
def upload_file():
    if 'files' not in request.files:
        return jsonify({'error': 'No files'}), 400
    
    files = request.files.getlist('files')
    uploaded = []
    failed = []
    
    for file in files:
        if not file.filename:
            continue
        try:
            filename = secure_filename(file.filename)
            file_path = os.path.join(app.config['UPLOAD_FOLDER'], filename)
            file.save(file_path)
            
            file_type = filename.split('.')[-1].lower()
            
            if file_type == 'pdf':
                text = extract_text_from_pdf(file_path)
            elif file_type == 'docx':
                text = extract_text_from_docx(file_path)
            elif file_type == 'txt':
                text = extract_text_from_txt(file_path)
            elif file_type in ['csv', 'xlsx', 'xls']:
                try:
                    df = pd.read_csv(file_path) if file_type == 'csv' else pd.read_excel(file_path)
                    text = df.to_string()
                except:
                    text = ""
            else:
                text = extract_text_from_txt(file_path)
            
            text = clean_text(text)
            
            if text and len(text.strip()) > 50:
                chunks = chunk_text(text)
                doc_id = f"doc_{int(time.time())}_{filename.replace('.', '_')}"
                
                if metadata_collection:
                    metadata_collection.add(
                        documents=[json.dumps({
                            'filename': filename,
                            'file_type': file_type,
                            'upload_date': str(pd.Timestamp.now()),
                            'chunks': len(chunks),
                            'doc_id': doc_id
                        })],
                        ids=[doc_id]
                    )
                
                if document_collection and embedding_model:
                    for i in range(0, len(chunks), 50):
                        batch = chunks[i:i+50]
                        embeddings = [embedding_model.encode(c).tolist() for c in batch]
                        ids = [f"{doc_id}_{j}" for j in range(i, i+len(batch))]
                        document_collection.add(
                            embeddings=embeddings,
                            documents=batch,
                            metadatas=[{'doc_id': doc_id, 'filename': filename} for _ in batch],
                            ids=ids
                        )
                
                uploaded.append({
                    'name': filename,
                    'type': file_type.upper(),
                    'chunks': len(chunks)
                })
                print(f"✅ {filename} ({len(chunks)} chunks)")
            else:
                failed.append({'name': filename, 'reason': 'No text extracted'})
            
            if os.path.exists(file_path):
                os.remove(file_path)
                
        except Exception as e:
            print(f"❌ {file.filename}: {e}")
            failed.append({'name': file.filename, 'reason': str(e)})
    
    return jsonify({'success': True, 'uploaded': uploaded, 'failed': failed})

@app.route('/chat', methods=['POST'])
def chat():
    try:
        data = request.json
        user_message = data.get('message', '').strip()
        
        if not user_message:
            return jsonify({'response': 'Please type a message.'}), 400
        
        if not groq_client:
            return jsonify({'response': 'AI service not available. Please check the API key configuration.'}), 500
        
        # Get document context
        doc_context = ""
        sources = []
        
        if document_collection and document_collection.count() > 0 and embedding_model:
            try:
                query_embedding = embedding_model.encode(user_message).tolist()
                results = document_collection.query(
                    query_embeddings=[query_embedding],
                    n_results=3
                )
                
                if results['documents'] and results['documents'][0]:
                    texts = []
                    for i, doc in enumerate(results['documents'][0]):
                        src = results['metadatas'][0][i].get('filename', '') if results['metadatas'] else ''
                        if src and src not in sources:
                            sources.append(src)
                        cleaned = clean_text(doc)
                        if len(cleaned) > 30:
                            texts.append(cleaned)
                    
                    if texts:
                        doc_context = "\n\n".join(texts[:3])
            except:
                pass
        
        # --- ULTRA-CLEAN, SHORT CHAT RESPONSE ---
        if doc_context:
            system_prompt = """You are chatting with a student who needs quick, clear answers.

RULES (follow strictly):
1. Give ONE short answer in 2-3 sentences max.
2. Write like you're texting a friend - casual, simple words.
3. NO paragraphs, NO bullet points, NO lists.
4. NO phrases like "Think of it like..." or "Well, basically..."
5. NO "According to..." or "The notes say..."
6. Just state the answer directly and simply.
7. If they ask "what is X", just define X in the simplest way possible.
8. Keep it under 50 words if possible."""

            user_prompt = f"""Notes for reference:\n{doc_context[:500]}\n\nStudent asks: {user_message}\n\nGive a single, short, direct answer (2-3 sentences):"""
        else:
            system_prompt = "Give very short, simple answers. 2-3 sentences max. Casual tone."
            user_prompt = f"Question: {user_message}\n\nShort answer:"
        
        # Get response
        response_text = None
        for model in ["llama-3.1-8b-instant", "llama-3.3-70b-versatile", "mixtral-8x7b-32768"]:
            try:
                completion = groq_client.chat.completions.create(
                    model=model,
                    messages=[
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": user_prompt}
                    ],
                    temperature=0.7,
                    max_tokens=150
                )
                response_text = completion.choices[0].message.content
                
                # Clean formatting
                response_text = re.sub(r'\*{1,3}', '', response_text)
                response_text = re.sub(r'#{1,4}\s*', '', response_text)
                response_text = re.sub(r'\[Source:.*?\]', '', response_text)
                response_text = re.sub(r'Think of it like.*?\.', '', response_text)
                response_text = re.sub(r'Well,?\s*,?\s*', '', response_text)
                response_text = re.sub(r'So,?\s*,?\s*', '', response_text)
                response_text = re.sub(r'Basically,?\s*,?\s*', '', response_text)
                response_text = response_text.strip()
                
                # Truncate to first 2 sentences
                sentences = re.split(r'(?<=[.!?])\s+', response_text)
                if len(sentences) > 2:
                    response_text = ' '.join(sentences[:2])
                
                break
            except:
                continue
        
        if response_text:
            return jsonify({
                'response': response_text,
                'sources': list(set(sources))[:3] if sources else []
            })
        else:
            return jsonify({'response': "Sorry, try again."}), 500
            
    except Exception as e:
        print(f"Chat error: {e}")
        return jsonify({'response': "Something went wrong."}), 500

@app.route('/check-status', methods=['GET'])
def check_status():
    doc_count = 0
    if document_collection:
        try:
            doc_count = document_collection.count()
        except:
            doc_count = 0
    
    return jsonify({
        'status': 'online',
        'documents_available': doc_count > 0,
        'document_count': doc_count,
        'api_connected': groq_connected
    })

@app.route('/admin/documents', methods=['GET'])
@admin_required
def get_documents():
    docs = []
    if metadata_collection:
        try:
            results = metadata_collection.get()
            if results['documents']:
                docs = [json.loads(d) for d in results['documents']]
                docs.sort(key=lambda x: x.get('upload_date', ''), reverse=True)
        except:
            pass
    return jsonify({'success': True, 'documents': docs})

@app.route('/admin/delete/<doc_id>', methods=['DELETE'])
@admin_required
def delete_document(doc_id):
    try:
        if document_collection:
            document_collection.delete(where={"doc_id": doc_id})
        if metadata_collection:
            metadata_collection.delete(ids=[doc_id])
        return jsonify({'success': True})
    except:
        return jsonify({'success': False}), 500

@app.route('/admin/stats')
@admin_required
def get_admin_stats():
    return jsonify({
        'success': True,
        'total_documents': metadata_collection.count() if metadata_collection else 0,
        'total_chunks': document_collection.count() if document_collection else 0
    })

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 7860))
    
    print("\n" + "="*60)
    print("🚀 SERVER STARTED")
    doc_count = document_collection.count() if document_collection else 0
    print(f"📚 Documents: {doc_count} chunks")
    print(f"🌐 Running on port {port}")
    print("="*60 + "\n")
    
    app.run(host='0.0.0.0', port=port, debug=False)