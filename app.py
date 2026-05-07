import os
import warnings
warnings.filterwarnings('ignore')
os.environ['HF_HUB_DISABLE_SYMLINKS_WARNING'] = '1'
os.environ['TOKENIZERS_PARALLELISM'] = 'false'

from flask import Flask, render_template, request, jsonify, session, redirect, url_for
from werkzeug.utils import secure_filename
from werkzeug.security import generate_password_hash, check_password_hash
from sentence_transformers import SentenceTransformer
from qdrant_client import QdrantClient
from qdrant_client.models import Distance, VectorParams, PointStruct
from huggingface_hub import HfApi
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
import uuid

load_dotenv()

# ========== HUGGING FACE SECRETS SUPPORT ==========
def load_hf_secrets():
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
    
    for secret_name in ['GROQ_API_KEY', 'SECRET_KEY', 'ADMIN_USERNAME', 'ADMIN_PASSWORD', 
                         'QDRANT_URL', 'QDRANT_API_KEY', 'HF_TOKEN', 'HF_DATASET']:
        if not os.environ.get(secret_name):
            paths = [f'/etc/secrets/{secret_name}', f'/secrets/{secret_name}', f'/run/secrets/{secret_name}']
            for path in paths:
                if os.path.exists(path):
                    try:
                        with open(path, 'r') as f:
                            os.environ[secret_name] = f.read().strip()
                        print(f"✅ Loaded secret: {secret_name}")
                        break
                    except:
                        pass

load_hf_secrets()

groq_key = os.environ.get('GROQ_API_KEY', 'NOT SET')
print(f"🔑 GROQ_API_KEY: {'SET' if groq_key != 'NOT SET' else 'NOT SET'}")
print(f"🔑 QDRANT_URL: {'SET' if os.environ.get('QDRANT_URL') else 'NOT SET'}")
print(f"🔑 HF_TOKEN: {'SET' if os.environ.get('HF_TOKEN') else 'NOT SET'}")

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

try:
    embedding_model = SentenceTransformer('all-MiniLM-L6-v2')
    print("✅ Embedding model loaded")
except:
    embedding_model = None
    print("❌ Embedding failed")

qdrant_client = None
try:
    qdrant_url = os.getenv('QDRANT_URL')
    qdrant_api_key = os.getenv('QDRANT_API_KEY')
    
    if qdrant_url and qdrant_api_key:
        qdrant_client = QdrantClient(url=qdrant_url, api_key=qdrant_api_key)
        
        collections = qdrant_client.get_collections().collections
        collection_names = [c.name for c in collections]
        
        if "university_notes" not in collection_names:
            qdrant_client.create_collection(
                collection_name="university_notes",
                vectors_config=VectorParams(size=384, distance=Distance.COSINE)
            )
            print("✅ Qdrant collection created")
        else:
            info = qdrant_client.get_collection("university_notes")
            print(f"✅ Qdrant connected ({info.points_count} documents)")
    else:
        print("⚠️ Qdrant credentials not found")
except Exception as e:
    print(f"❌ Qdrant connection failed: {e}")
    qdrant_client = None

hf_api = None
hf_dataset = os.getenv('HF_DATASET', '')
try:
    hf_token = os.getenv('HF_TOKEN')
    if hf_token and hf_dataset:
        hf_api = HfApi(token=hf_token)
        print(f"✅ HF Dataset ready: {hf_dataset}")
    else:
        print("⚠️ HF Dataset credentials not found")
except Exception as e:
    print(f"⚠️ HF Dataset setup failed: {e}")

groq_api_key = os.getenv('GROQ_API_KEY')
groq_client = None
groq_connected = False

if groq_api_key:
    try:
        from groq import Groq
        groq_client = Groq(api_key=groq_api_key)
        print("✅ Groq client created")
        groq_connected = True
    except:
        try:
            import requests
            print("✅ Using HTTP fallback for Groq")
            groq_client = "http_fallback"
            groq_connected = True
        except:
            print("❌ Groq failed")

print("="*60 + "\n")

def admin_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if 'admin_logged_in' not in session:
            return redirect(url_for('admin_login_page'))
        return f(*args, **kwargs)
    return decorated_function

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

def groq_chat_completion(messages, model="llama-3.1-8b-instant", max_tokens=150, temperature=0.7):
    import requests
    url = "https://api.groq.com/openai/v1/chat/completions"
    headers = {
        "Authorization": f"Bearer {groq_api_key}",
        "Content-Type": "application/json"
    }
    payload = {
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature
    }
    response = requests.post(url, json=payload, headers=headers, timeout=30)
    if response.status_code == 200:
        return response.json()["choices"][0]["message"]["content"]
    else:
        raise Exception(f"Groq API error: {response.status_code}")

def upload_to_hf_dataset(file_path, filename):
    if not hf_api or not hf_dataset:
        print("⚠️ HF Dataset not configured - skipping backup")
        return False
    try:
        path_in_repo = f"documents/{filename}"
        hf_api.upload_file(
            path_or_fileobj=file_path,
            path_in_repo=path_in_repo,
            repo_id=hf_dataset,
            repo_type="dataset"
        )
        print(f"✅ Backed up to HF: {filename}")
        return True
    except Exception as e:
        print(f"⚠️ HF backup failed: {e}")
        return False

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
    category = request.form.get('category', '')
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
                points = []
                for i, chunk in enumerate(chunks):
                    embedding = embedding_model.encode(chunk).tolist()
                    point_id = str(uuid.uuid4())
                    points.append(PointStruct(
                        id=point_id,
                        vector=embedding,
                        payload={
                            "filename": filename,
                            "text": chunk,
                            "chunk_index": i,
                            "category": category,
                            "file_type": file_type,
                            "upload_date": str(pd.Timestamp.now())
                        }
                    ))
                
                if qdrant_client:
                    qdrant_client.upsert(collection_name="university_notes", points=points)
                    print(f"✅ Qdrant: {filename} ({len(chunks)} chunks)")
                
                upload_to_hf_dataset(file_path, filename)
                uploaded.append({'name': filename, 'type': file_type.upper(), 'chunks': len(chunks)})
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
            return jsonify({'response': 'AI service not available.'}), 500
        
        user_lower = user_message.lower().strip()
        
        # Message classification
        greetings = ['hi', 'hello', 'hey', 'good morning', 'good afternoon', 'good evening', 
                     'how are you', 'whats up', "what's up", 'sup', 'yo', 'hola',
                     'hii', 'heyy', 'helloo', 'morning', 'evening', 'good day']
        personal_q = ['your name', 'who are you', 'what are you', 'know my name',
                     'do you know me', 'who am i', 'what is my name',
                     'about yourself', 'introduce yourself', 'who created you',
                     'are you ai', 'are you human', 'your country', 'where are you from',
                     'where do you live', 'are you real']
        small_talk = ['how are you', 'how do you do', 'how is it going', 'how are things']
        thanks = ['thank', 'thanks', 'thx', 'appreciate']
        
        is_greeting = any(g in user_lower for g in greetings) and len(user_message.split()) <= 4
        is_personal = any(p in user_lower for p in personal_q)
        is_small_talk = any(s in user_lower for s in small_talk)
        is_thanks = any(t in user_lower for t in thanks) and len(user_message.split()) <= 4
        is_casual = is_greeting or is_personal or is_small_talk or is_thanks
        
        # Search documents (skip for casual)
        doc_context = ""
        sources = []
        if qdrant_client and embedding_model and not is_casual:
            try:
                query_embedding = embedding_model.encode(user_message).tolist()
                search_results = qdrant_client.search(
                    collection_name="university_notes",
                    query_vector=query_embedding, limit=3
                )
                if search_results:
                    texts = []
                    for hit in search_results:
                        payload = hit.payload
                        filename = payload.get('filename', 'Unknown')
                        if filename not in sources:
                            sources.append(filename)
                        texts.append(payload.get('text', ''))
                    if texts:
                        doc_context = "\n\n".join(texts[:3])
            except:
                pass
        
        # Build prompt
        if is_greeting:
            system_prompt = """You are a friendly AI assistant. Give a SHORT, warm greeting.
Be natural and conversational. Keep it to 1-2 sentences.
DO NOT mention documents, notes, or study materials."""
            user_prompt = f"User: {user_message}\n\nFriendly response:"
            max_tokens = 60
        elif is_personal:
            system_prompt = """You are a friendly AI answering a personal question.
Be honest: You're an AI assistant, not human. No physical location or personal history.
Keep it short, friendly, and natural. DO NOT mention documents or notes."""
            user_prompt = f"User: {user_message}\n\nNatural AI response:"
            max_tokens = 100
        elif is_small_talk:
            system_prompt = """Respond warmly to small talk. 1-2 sentences. Be positive.
DO NOT mention documents or study materials."""
            user_prompt = f"User: {user_message}\n\nNatural response:"
            max_tokens = 60
        elif is_thanks:
            system_prompt = "Respond to thanks warmly in 1 short sentence."
            user_prompt = f"User: {user_message}\n\nGracious response:"
            max_tokens = 40
        elif doc_context:
            system_prompt = """You are a helpful AI tutor. Answer naturally like any AI would.

CRITICAL: NEVER mention "notes", "documents", "files", "PDFs", or "study materials".
NEVER say "According to..." or "The documents say...".
Just give the answer as if YOU know it. Be conversational and helpful.
If the reference material helps, use it - but never attribute it.
If it doesn't help, use your own knowledge.
Keep answers clear - 3-5 sentences max."""
            user_prompt = f"""Reference (use silently, NEVER mention):
{doc_context[:800]}

Question: {user_message}

Natural answer (DO NOT mention documents/notes/files):"""
            max_tokens = 250
        else:
            system_prompt = """You are a smart AI assistant. Answer naturally and helpfully.
Answer ANY question using your knowledge. Be conversational.
For definitions: 2-3 sentences. For explanations: 3-5 sentences.
NEVER say you don't have documents. Just answer the question."""
            user_prompt = f"Question: {user_message}\n\nNatural answer:"
            max_tokens = 300
        
        # Get response
        response_text = None
        used_model = None
        models_to_try = ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "mixtral-8x7b-32768"]
        
        if groq_client == "http_fallback":
            for model in models_to_try:
                try:
                    response_text = groq_chat_completion(
                        messages=[{"role": "system", "content": system_prompt}, {"role": "user", "content": user_prompt}],
                        model=model, max_tokens=max_tokens, temperature=0.7
                    )
                    used_model = model
                    break
                except:
                    continue
        else:
            for model in models_to_try:
                try:
                    completion = groq_client.chat.completions.create(
                        model=model,
                        messages=[{"role": "system", "content": system_prompt}, {"role": "user", "content": user_prompt}],
                        temperature=0.7, max_tokens=max_tokens
                    )
                    response_text = completion.choices[0].message.content
                    used_model = model
                    break
                except:
                    continue
        
        if response_text:
            response_text = re.sub(r'\*{1,3}', '', response_text)
            response_text = re.sub(r'#{1,4}\s*', '', response_text)
            
            # Remove any mention of notes/documents/files
            phrases_to_remove = [
                r'(?i)according to the (study )?(notes|documents?|files?|PDFs?|materials?)[,.!]*\s*',
                r'(?i)the (study )?(notes|documents?|files?|PDFs?|materials?) (say|mention|indicate|show|suggest|contain)[,.!]*\s*',
                r'(?i)based on the (study )?(notes|documents?|files?|PDFs?|materials?)[,.!]*\s*',
                r'(?i)I (don\'?t|do not) (have|see) (any |the )?(study )?(notes|documents?|files?|PDFs?|materials?)[,.!]*\s*',
                r'(?i)the (study )?(notes|documents?|files?|PDFs?|materials?) (don\'?t|do not)[,.!]*\s*',
                r'(?i)reference material[s]?[,.!]*\s*',
                r'(?i)course material[s]?[,.!]*\s*',
            ]
            for phrase in phrases_to_remove:
                response_text = re.sub(phrase, '', response_text)
            response_text = response_text.strip()
            
            # Safety nets
            if is_greeting and (len(response_text) > 100 or 'note' in response_text.lower()):
                response_text = "Hey there! 👋 How can I help you today?"
            if is_personal and ('note' in response_text.lower() or 'document' in response_text.lower() or len(response_text) > 120):
                response_text = "I'm an AI assistant here to help with your questions! I don't have a physical location or personal history. 😊"
            if is_thanks and len(response_text) > 60:
                response_text = "You're welcome! Happy to help! 😊"
            if not response_text or len(response_text) < 5:
                response_text = "Hey! How can I help you today? 😊"
            
            return jsonify({
                'response': response_text,
                'sources': list(set(sources))[:3] if sources and not is_casual else []
            })
        else:
            return jsonify({'response': "I'm having trouble right now. Could you try again?"}), 500
    except Exception as e:
        print(f"Chat error: {e}")
        return jsonify({'response': "Sorry, I encountered an issue. Please try again!"}), 500

@app.route('/check-status', methods=['GET'])
def check_status():
    doc_count = 0
    if qdrant_client:
        try:
            info = qdrant_client.get_collection("university_notes")
            doc_count = info.points_count
        except:
            pass
    return jsonify({
        'status': 'online',
        'documents_available': doc_count > 0,
        'document_count': doc_count,
        'api_connected': groq_connected,
        'qdrant_connected': qdrant_client is not None,
        'hf_backup_ready': hf_api is not None
    })

@app.route('/admin/documents', methods=['GET'])
@admin_required
def get_documents():
    docs = []
    if qdrant_client:
        try:
            scroll_results = qdrant_client.scroll(
                collection_name="university_notes", limit=100, with_payload=True, with_vectors=False
            )
            seen = set()
            for point in scroll_results[0]:
                filename = point.payload.get('filename', '')
                if filename and filename not in seen:
                    seen.add(filename)
                    docs.append({
                        'filename': filename,
                        'file_type': point.payload.get('file_type', ''),
                        'category': point.payload.get('category', ''),
                        'upload_date': point.payload.get('upload_date', ''),
                        'doc_id': point.id,
                        'chunks': 1
                    })
        except:
            pass
    return jsonify({'success': True, 'documents': docs})

@app.route('/admin/delete/<doc_id>', methods=['DELETE'])
@admin_required
def delete_document(doc_id):
    try:
        if qdrant_client:
            qdrant_client.delete(collection_name="university_notes", points_selector=[doc_id])
        return jsonify({'success': True})
    except:
        return jsonify({'success': False}), 500

@app.route('/admin/stats')
@admin_required
def get_admin_stats():
    doc_count = 0
    if qdrant_client:
        try:
            info = qdrant_client.get_collection("university_notes")
            doc_count = info.points_count
        except:
            pass
    return jsonify({'success': True, 'total_documents': doc_count, 'total_chunks': doc_count})

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 7860))
    doc_count = 0
    if qdrant_client:
        try:
            info = qdrant_client.get_collection("university_notes")
            doc_count = info.points_count
        except:
            pass
    print("\n" + "="*60)
    print("🚀 SERVER STARTED")
    print(f"📚 Documents: {doc_count}")
    print(f"🌐 http://0.0.0.0:{port}/")
    print("="*60 + "\n")
    app.run(host='0.0.0.0', port=port, debug=False)