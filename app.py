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
import requests
import urllib.parse

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
except:
    pass

groq_api_key = os.getenv('GROQ_API_KEY')
groq_client = None
groq_connected = False
if groq_api_key:
    try:
        from groq import Groq
        groq_client = Groq(api_key=groq_api_key)
        groq_connected = True
        print("✅ Groq client created")
    except:
        try:
            import requests
            groq_client = "http_fallback"
            groq_connected = True
            print("✅ Using HTTP fallback for Groq")
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
    url = "https://api.groq.com/openai/v1/chat/completions"
    headers = {"Authorization": f"Bearer {groq_api_key}", "Content-Type": "application/json"}
    payload = {"model": model, "messages": messages, "max_tokens": max_tokens, "temperature": temperature}
    response = requests.post(url, json=payload, headers=headers, timeout=30)
    if response.status_code == 200:
        return response.json()["choices"][0]["message"]["content"]
    else:
        raise Exception(f"Groq API error: {response.status_code}")

def upload_to_hf_dataset(file_path, filename):
    if not hf_api or not hf_dataset: return False
    try:
        hf_api.upload_file(path_or_fileobj=file_path, path_in_repo=f"documents/{filename}",
                          repo_id=hf_dataset, repo_type="dataset")
        return True
    except:
        return False

# ========== WIKIPEDIA DIRECT CONNECTION ==========

def get_wikipedia_summary(query):
    """Get accurate, up-to-date information directly from Wikipedia"""
    try:
        query = query.lower().strip()
        query = query.replace('srilanka', 'sri lanka')
        
        search_url = f"https://en.wikipedia.org/w/api.php?action=opensearch&search={urllib.parse.quote(query)}&limit=3&format=json"
        response = requests.get(search_url, headers={"User-Agent": "AI-Chatbot/1.0"}, timeout=10)
        data = response.json()
        
        if len(data) >= 2 and data[1]:
            summaries = []
            for page_title in data[1][:3]:
                try:
                    summary_url = f"https://en.wikipedia.org/api/rest_v1/page/summary/{urllib.parse.quote(page_title)}"
                    summary_response = requests.get(summary_url, headers={"User-Agent": "AI-Chatbot/1.0"}, timeout=10)
                    summary_data = summary_response.json()
                    
                    extract = summary_data.get('extract', '')
                    if extract:
                        sentences = re.split(r'(?<=[.!?])\s+', extract)
                        snippet = ' '.join(sentences[:5])
                        summaries.append({
                            "title": page_title,
                            "snippet": snippet,
                            "link": f"https://en.wikipedia.org/wiki/{urllib.parse.quote(page_title.replace(' ', '_'))}"
                        })
                except:
                    continue
            
            if summaries:
                print(f"✅ Wikipedia: {len(summaries)} articles for '{query[:60]}'")
                return summaries
    except Exception as e:
        print(f"⚠️ Wikipedia error: {e}")
    return None

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
    uploaded, failed = [], []
    for file in files:
        if not file.filename: continue
        try:
            filename = secure_filename(file.filename)
            file_path = os.path.join(app.config['UPLOAD_FOLDER'], filename)
            file.save(file_path)
            file_type = filename.split('.')[-1].lower()
            if file_type == 'pdf': text = extract_text_from_pdf(file_path)
            elif file_type == 'docx': text = extract_text_from_docx(file_path)
            elif file_type == 'txt': text = extract_text_from_txt(file_path)
            elif file_type in ['csv', 'xlsx', 'xls']:
                try: text = (pd.read_csv(file_path) if file_type == 'csv' else pd.read_excel(file_path)).to_string()
                except: text = ""
            else: text = extract_text_from_txt(file_path)
            text = clean_text(text)
            if text and len(text.strip()) > 50:
                chunks = chunk_text(text)
                points = []
                for i, chunk in enumerate(chunks):
                    embedding = embedding_model.encode(chunk).tolist()
                    points.append(PointStruct(id=str(uuid.uuid4()), vector=embedding,
                        payload={"filename": filename, "text": chunk, "chunk_index": i,
                                "category": category, "file_type": file_type,
                                "upload_date": str(pd.Timestamp.now())}))
                if qdrant_client:
                    qdrant_client.upsert(collection_name="university_notes", points=points)
                    print(f"✅ Qdrant: {filename} ({len(chunks)} chunks)")
                upload_to_hf_dataset(file_path, filename)
                uploaded.append({'name': filename, 'type': file_type.upper(), 'chunks': len(chunks)})
            else:
                failed.append({'name': filename, 'reason': 'No text extracted'})
            if os.path.exists(file_path): os.remove(file_path)
        except Exception as e:
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
        msg_len = len(user_lower.split())
        
        # ========== CLASSIFY ==========
        greetings = ['hi', 'hello', 'hey', 'good morning', 'good afternoon', 'good evening', 
                    'sup', 'yo', 'hola', 'hii', 'heyy', 'helloo', 'morning', 'evening']
        is_greeting = any(user_lower == g or user_lower.startswith(g + ' ') for g in greetings) and msg_len <= 3
        
        short_acks = ['ok', 'okay', 'k', 'fine', 'sure', 'yes', 'yeah', 'yep', 'no', 'nope', 
                     'right', 'got it', 'gotcha', 'understood', 'alright', 'cool', 'nice',
                     'good', 'great', 'hmm', 'hm', 'ah', 'oh', 'i see']
        is_short_ack = user_lower in short_acks or msg_len == 1
        
        thanks_words = ['thank', 'thanks', 'thx', 'appreciate']
        is_thanks = any(t in user_lower for t in thanks_words) and msg_len <= 4
        
        identity_q = ['who are you', 'what are you', 'your name', 'about yourself', 
                     'introduce yourself', 'who created you', 'are you ai', 'are you human']
        location_q = ['where are you', 'where do you live', 'your country', 'your location']
        is_about_ai = any(q in user_lower for q in identity_q) or any(q in user_lower for q in location_q)
        
        is_casual = is_greeting or is_short_ack or is_thanks or is_about_ai
        
        print(f"📝 {user_message[:80]}")
        print(f"   is_casual={is_casual}")
        
        # ========== SEARCH DOCUMENTS FIRST ==========
        doc_context = ""
        sources = []
        found_in_docs = False
        
        if qdrant_client and embedding_model and not is_casual:
            try:
                query_embedding = embedding_model.encode(user_message).tolist()
                search_results = qdrant_client.search(
                    collection_name="university_notes", query_vector=query_embedding, limit=3)
                if search_results:
                    texts = []
                    for hit in search_results:
                        payload = hit.payload
                        filename = payload.get('filename', 'Unknown')
                        if filename not in sources: sources.append(filename)
                        texts.append(payload.get('text', ''))
                    if texts:
                        doc_context = "\n\n".join(texts[:3])
                        if len(doc_context) > 100:
                            found_in_docs = True
                            print(f"📚 Found in documents ({len(texts)} chunks)")
            except Exception as e:
                print(f"Document search error: {e}")
        
        # ========== WIKIPEDIA FALLBACK ==========
        wiki_results = None
        if not is_casual and not found_in_docs:
            print(f"🔍 Searching Wikipedia...")
            wiki_results = get_wikipedia_summary(user_message)
        
        # ========== BUILD PROMPT ==========
        
        if is_greeting:
            system_prompt = "Friendly AI. SHORT greeting (1 sentence)."
            user_prompt = f"User: {user_message}\n\nShort greeting:"
            max_tokens = 50
            temperature = 0.7
            
        elif is_short_ack:
            system_prompt = "Friendly AI. Short acknowledgment (1 sentence)."
            user_prompt = f"User: {user_message}\n\nShort response:"
            max_tokens = 40
            temperature = 0.7
            
        elif is_thanks:
            system_prompt = "Respond to thanks warmly. 1 sentence."
            user_prompt = f"User: {user_message}\n\nResponse:"
            max_tokens = 30
            temperature = 0.7
            
        elif is_about_ai:
            system_prompt = "AI assistant. Be honest about being AI. 2 friendly sentences."
            user_prompt = f"User: {user_message}\n\nFriendly response:"
            max_tokens = 80
            temperature = 0.7
            
        elif found_in_docs:
            system_prompt = """Helpful AI tutor. Answer from course material.
NEVER mention "study notes", "documents", "files", "PDFs".
Answer naturally. 3-5 sentences max."""
            user_prompt = f"""Course material (silent):
{doc_context[:800]}

Question: {user_message}

Natural answer:"""
            max_tokens = 250
            temperature = 0.7
            
        elif wiki_results:
            wiki_context = "\n\n".join([f"ARTICLE: {r['title']}\n{r['snippet']}" for r in wiki_results])
            print(f"📖 Wikipedia: {len(wiki_context)} chars")
            print(f"   Preview: {wiki_context[:200]}...")
            
            system_prompt = """READ THE WIKIPEDIA TEXT BELOW.
EXTRACT the answer from the Wikipedia text.
STATE the answer directly in 1-2 sentences.
DO NOT say "I don't know".
DO NOT mention RPC, RMI, or previous topics.
DO NOT say "that's not related".
JUST ANSWER using the Wikipedia text."""
            
            user_prompt = f"""WIKIPEDIA INFORMATION:
{wiki_context[:1200]}

QUESTION: {user_message}

ANSWER (use Wikipedia info above):"""
            max_tokens = 200
            temperature = 0.1
            
        else:
            system_prompt = """Smart AI assistant. Answer naturally using your knowledge.
3-5 sentences for explanations, 2-3 for definitions."""
            user_prompt = f"Question: {user_message}\n\nNatural answer:"
            max_tokens = 300
            temperature = 0.7
        
        # ========== GET RESPONSE ==========
        response_text = None
        models_to_try = ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "mixtral-8x7b-32768"]
        
        if groq_client == "http_fallback":
            for model in models_to_try:
                try:
                    response_text = groq_chat_completion(
                        messages=[{"role": "system", "content": system_prompt}, 
                                 {"role": "user", "content": user_prompt}],
                        model=model, max_tokens=max_tokens, temperature=temperature)
                    break
                except: continue
        else:
            for model in models_to_try:
                try:
                    completion = groq_client.chat.completions.create(
                        model=model,
                        messages=[{"role": "system", "content": system_prompt}, 
                                 {"role": "user", "content": user_prompt}],
                        temperature=temperature, max_tokens=max_tokens)
                    response_text = completion.choices[0].message.content
                    break
                except: continue
        
        # ========== CLEAN ==========
        if response_text:
            response_text = re.sub(r'\*{1,3}', '', response_text)
            response_text = re.sub(r'#{1,4}\s*', '', response_text)
            
            # FORCE Wikipedia text if AI refuses to answer
            if wiki_results and ('not aware' in response_text.lower() or "don't know" in response_text.lower() or 'not related' in response_text.lower() or 'rpc' in response_text.lower() or 'rmi' in response_text.lower()):
                first_snippet = wiki_results[0]['snippet'][:300]
                response_text = first_snippet
                print("⚠️ AI refused - using Wikipedia directly")
            
            bad_phrases = [
                r"(?i).*study notes.*?\.\s*",
                r"(?i).*the (documents?|files?|PDFs?|notes).*?\.\s*",
                r"(?i).*according to.*?\.\s*",
                r"(?i).*based on.*?\.\s*",
                r"(?i)that'?s not related.*?\.\s*",
                r"(?i)would you like to go back.*?\?\s*",
                r"(?i)remote procedure call.*?[.!]\s*",
            ]
            for phrase in bad_phrases:
                response_text = re.sub(phrase, '', response_text)
            response_text = response_text.strip()
            
            if is_greeting and len(response_text) > 80:
                response_text = "Hey there! 👋 How can I help you today?"
            if is_short_ack and len(response_text) > 60:
                response_text = "Is there anything else I can help with? 😊"
            if is_thanks and len(response_text) > 40:
                response_text = "You're welcome! 😊"
            if not response_text or len(response_text) < 2:
                response_text = "How can I help you today?"
            
            return jsonify({
                'response': response_text,
                'sources': [],
                'mode': 'wiki' if wiki_results else ('study' if found_in_docs else 'general')
            })
        else:
            return jsonify({'response': "I'm having trouble. Please try again!"}), 500
            
    except Exception as e:
        print(f"Chat error: {e}")
        return jsonify({'response': "Sorry, something went wrong. Please try again!"}), 500

@app.route('/check-status', methods=['GET'])
def check_status():
    doc_count = 0
    if qdrant_client:
        try: doc_count = qdrant_client.get_collection("university_notes").points_count
        except: pass
    return jsonify({
        'status': 'online',
        'documents_available': doc_count > 0,
        'document_count': doc_count,
        'api_connected': groq_connected,
        'qdrant_connected': qdrant_client is not None,
        'knowledge_source': 'Documents + Wikipedia (Free)'
    })

@app.route('/admin/documents', methods=['GET'])
@admin_required
def get_documents():
    docs = []
    if qdrant_client:
        try:
            scroll_results = qdrant_client.scroll(
                collection_name="university_notes", limit=100, with_payload=True, with_vectors=False)
            seen = set()
            for point in scroll_results[0]:
                filename = point.payload.get('filename', '')
                if filename and filename not in seen:
                    seen.add(filename)
                    docs.append({
                        'filename': filename, 'file_type': point.payload.get('file_type', ''),
                        'category': point.payload.get('category', ''),
                        'upload_date': point.payload.get('upload_date', ''),
                        'doc_id': point.id, 'chunks': 1
                    })
        except: pass
    return jsonify({'success': True, 'documents': docs})

@app.route('/admin/delete/<doc_id>', methods=['DELETE'])
@admin_required
def delete_document(doc_id):
    try:
        if qdrant_client:
            qdrant_client.delete(collection_name="university_notes", points_selector=[doc_id])
        return jsonify({'success': True})
    except: return jsonify({'success': False}), 500

@app.route('/admin/stats')
@admin_required
def get_admin_stats():
    doc_count = 0
    if qdrant_client:
        try: doc_count = qdrant_client.get_collection("university_notes").points_count
        except: pass
    return jsonify({'success': True, 'total_documents': doc_count, 'total_chunks': doc_count})

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 7860))
    doc_count = 0
    if qdrant_client:
        try: doc_count = qdrant_client.get_collection("university_notes").points_count
        except: pass
    print("\n" + "="*60)
    print("🚀 SERVER STARTED")
    print(f"📚 Documents: {doc_count}")
    print(f"📖 Knowledge: Documents + Wikipedia (Free)")
    print(f"🌐 http://0.0.0.0:{port}/")
    print("="*60 + "\n")
    app.run(host='0.0.0.0', port=port, debug=False)