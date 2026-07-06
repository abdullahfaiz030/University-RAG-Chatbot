from pptx import Presentation
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

def extract_text_from_pptx(file_path):
    """Extract text from PowerPoint (.pptx) files including tables"""
    text = ""
    try:
        prs = Presentation(file_path)
        for slide_num, slide in enumerate(prs.slides, 1):
            slide_text = ""
            for shape in slide.shapes:
                if hasattr(shape, "text") and shape.text.strip():
                    slide_text += shape.text + "\n"
                if shape.has_table:
                    table = shape.table
                    for row in table.rows:
                        row_text = " | ".join(cell.text.strip() for cell in row.cells if cell.text.strip())
                        if row_text:
                            slide_text += row_text + "\n"
            if slide_text.strip():
                text += f"\n--- Slide {slide_num} ---\n{slide_text}\n"
    except Exception as e:
        print(f"PPTX extraction error: {e}")
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

# ========== WEB SEARCH ==========

def search_duckduckgo(query):
    try:
        from duckduckgo_search import DDGS
        results = []
        with DDGS() as ddgs:
            search_results = list(ddgs.text(query, max_results=3))
            for r in search_results:
                results.append({
                    "title": r.get("title", ""),
                    "snippet": r.get("body", ""),
                    "link": r.get("href", ""),
                    "source": "DuckDuckGo"
                })
        return results if results else None
    except:
        return None

def search_wikipedia(query):
    try:
        wiki_url = f"https://en.wikipedia.org/api/rest_v1/page/summary/{requests.utils.quote(query)}"
        wiki_response = requests.get(wiki_url, timeout=8)
        if wiki_response.status_code == 200:
            wiki_data = wiki_response.json()
            return [{
                "title": wiki_data.get("title", query),
                "snippet": wiki_data.get("extract", "")[:500],
                "source": "Wikipedia",
                "link": wiki_data.get("content_urls", {}).get("desktop", {}).get("page", "")
            }]
        return None
    except:
        return None

def search_anysearch(query):
    try:
        url = "https://anysearch-mcp.khulnasoft.com/search"
        payload = {"query": query, "limit": 3}
        response = requests.post(url, json=payload, timeout=10)
        if response.status_code == 200:
            data = response.json()
            results = []
            for item in data.get("results", [])[:3]:
                results.append({
                    "title": item.get("title", ""),
                    "snippet": item.get("snippet", ""),
                    "link": item.get("url", ""),
                    "source": "AnySearch"
                })
            return results if results else None
        return None
    except:
        return None

def search_web(query):
    all_results = []
    ddg_results = search_duckduckgo(query)
    if ddg_results: all_results.extend(ddg_results)
    wiki_results = search_wikipedia(query)
    if wiki_results: all_results.extend(wiki_results)
    if len(all_results) < 2:
        any_results = search_anysearch(query)
        if any_results: all_results.extend(any_results)
    return all_results if all_results else None

def search_multi_news(query):
    all_results = []
    try:
        from duckduckgo_search import DDGS
        with DDGS() as ddgs:
            news_results = list(ddgs.news(query, max_results=2))
            for r in news_results:
                all_results.append({
                    "title": r.get("title", ""),
                    "snippet": r.get("body", ""),
                    "source": "DuckDuckGo News",
                    "link": r.get("url", "")
                })
    except:
        pass
    return all_results if all_results else None

def extract_chart_data(user_message, web_results):
    user_lower = user_message.lower()
    chart_triggers = ['compare', 'comparison', 'chart', 'graph', 'statistics', 'data', 'numbers', 
                      'population', 'gdp', 'price', 'percentage', 'how many', 'how much']
    if not any(trigger in user_lower for trigger in chart_triggers): return None
    chart_data = {}
    if web_results:
        for r in web_results:
            snippet = r.get('snippet', '')
            pairs = re.findall(r'(\w+(?:\s+\w+)?)\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(?:million|billion|%|percent)?', snippet, re.IGNORECASE)
            for label, value in pairs[:3]: chart_data[label.strip()] = float(value)
    return chart_data if len(chart_data) >= 2 else None

def get_language_name(lang_code):
    lang_map = {
        'en': 'English', 'si': 'Sinhala', 'ta': 'Tamil', 'fr': 'French',
        'es': 'Spanish', 'de': 'German', 'zh': 'Chinese', 'ja': 'Japanese',
        'ko': 'Korean', 'ar': 'Arabic'
    }
    return lang_map.get(lang_code, 'English')

def needs_real_time_info(user_message):
    user_lower = user_message.lower()
    real_time_indicators = [
        'current', 'latest', 'today', 'now', '2024', '2025', '2026',
        'president', 'prime minister', 'election', 'news', 'recent',
        'weather', 'stock', 'price', 'score', 'live', 'update',
        'who is the', 'who is current', 'currently', 'right now',
        'who is president', 'who is prime minister', 'who leads',
        'leader of', 'head of state', 'who governs',
        'what is the capital', 'population of', 'weather in',
    ]
    return any(indicator in user_lower for indicator in real_time_indicators)

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
            elif file_type in ['pptx', 'ppt']:
                text = extract_text_from_pptx(file_path)
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
        
        question_words = ['what', 'who', 'where', 'when', 'why', 'how', 'which', 'whose', 'whom', 'can you', 'could you', 'tell me', 'explain', 'define', 'describe']
        is_question = any(user_lower.startswith(q) for q in question_words) or user_message.strip().endswith('?')
        
        greetings = ['hi', 'hello', 'hey', 'good morning', 'good afternoon', 'good evening', 'sup', 'yo', 'hola', 'hii', 'heyy', 'helloo', 'morning', 'evening', 'good day']
        is_greeting = any(user_lower == g or user_lower.startswith(g + ' ') for g in greetings) and len(user_message.split()) <= 3 and not is_question
        
        identity_q = ['who are you', 'what are you', 'your name', 'about yourself', 'introduce yourself', 'tell me about yourself', 'who created you', 'are you ai', 'are you human', 'are you real']
        location_q = ['where are you', 'where do you live', 'your country', 'which country', 'where you from', 'your location']
        user_personal_q = ['know my name', 'do you know me', 'who am i', 'what is my name', 'remember me']
        
        is_identity = any(q in user_lower for q in identity_q)
        is_location = any(q in user_lower for q in location_q) 
        is_user_personal = any(q in user_lower for q in user_personal_q)
        is_about_ai = is_identity or is_location
        
        thanks_words = ['thank', 'thanks', 'thx', 'appreciate']
        is_thanks = any(t in user_lower for t in thanks_words) and len(user_message.split()) <= 4 and not is_question
        
        needs_realtime = needs_real_time_info(user_message)
        is_casual = is_greeting or is_thanks or is_about_ai or is_user_personal
        
        web_results = None
        if needs_realtime and not is_casual:
            web_results = search_web(user_message)
        
        doc_context = ""
        if qdrant_client and embedding_model and not is_casual and not web_results:
            try:
                query_embedding = embedding_model.encode(user_message).tolist()
                search_results = qdrant_client.search(
                    collection_name="university_notes", query_vector=query_embedding, limit=3
                )
                if search_results:
                    texts = []
                    for hit in search_results:
                        texts.append(hit.payload.get('text', ''))
                    if texts:
                        doc_context = "\n\n".join(texts[:3])
            except Exception as e:
                print(f"Search error: {e}")
        
        # ========== PROMPTS (SHORT & DIRECT) ==========
        
        if is_greeting:
            system_prompt = "You are a friendly AI. Give a SHORT greeting. 1 sentence only."
            user_prompt = f"User: {user_message}\n\nShort greeting:"
            max_tokens = 30
        elif is_identity:
            system_prompt = "You are an AI assistant. In 1-2 short sentences, explain you're an AI created to help people learn."
            user_prompt = f"User: {user_message}\n\nShort response:"
            max_tokens = 60
        elif is_location:
            system_prompt = "You are an AI. In 1 short sentence, explain you don't have a physical location."
            user_prompt = f"User: {user_message}\n\nShort response:"
            max_tokens = 40
        elif is_user_personal:
            system_prompt = "In 1-2 short sentences, honestly say you don't know their name but you're happy to help."
            user_prompt = f"User: {user_message}\n\nShort response:"
            max_tokens = 40
        elif is_thanks:
            system_prompt = "Respond to thanks in 1 very short, warm sentence."
            user_prompt = f"User: {user_message}\n\nShort response:"
            max_tokens = 20
        elif web_results:
            web_context = ""
            for r in web_results[:3]:
                web_context += f"📰 {r.get('title', '')}: {r.get('snippet', '')}\n\n"
            system_prompt = "You are a helpful AI with web access. Answer in 1-3 SHORT sentences. Be direct. NO paragraphs."
            user_prompt = f"Web results:\n{web_context}\n\nQuestion: {user_message}\n\nShort answer:"
            max_tokens = 120
        elif doc_context:
            system_prompt = "You are a helpful AI tutor. Answer in 1-3 SHORT sentences. Be direct. NEVER mention notes or documents."
            user_prompt = f"Reference (read silently):\n{doc_context[:500]}\n\nQuestion: {user_message}\n\nShort answer:"
            max_tokens = 100
        else:
            system_prompt = "You are a smart AI assistant. Answer in 1-3 SHORT sentences. Be direct. NO paragraphs."
            user_prompt = f"Question: {user_message}\n\nShort answer:"
            max_tokens = 100
        
        # ========== GET RESPONSE ==========
        response_text = None
        models_to_try = ["llama-3.1-8b-instant", "llama-3.3-70b-versatile", "mixtral-8x7b-32768"]
        
        if groq_client == "http_fallback":
            for model in models_to_try:
                try:
                    response_text = groq_chat_completion(
                        messages=[{"role": "system", "content": system_prompt}, {"role": "user", "content": user_prompt}],
                        model=model, max_tokens=max_tokens, temperature=0.7
                    )
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
                    break
                except:
                    continue
        
        if response_text:
            response_text = re.sub(r'\*{1,3}', '', response_text)
            response_text = re.sub(r'#{1,4}\s*', '', response_text)
            response_text = response_text.strip()
            
            if is_greeting and (len(response_text) < 2 or len(response_text) > 60):
                response_text = "Hey there! 👋 How can I help you today?"
            if is_thanks and len(response_text) > 30:
                response_text = "You're welcome! 😊"
            if not response_text or len(response_text) < 2:
                response_text = "How can I help you today?"
            
            return jsonify({'response': response_text, 'sources': [], 'mode': 'realtime' if web_results else ('study' if doc_context else 'general')})
        else:
            return jsonify({'response': "I'm having trouble right now. Could you try asking again?"}), 500
            
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
        'web_search': 'DuckDuckGo + Wikipedia + AnySearch (All Free)'
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
    print(f"🔍 Web Search: DuckDuckGo + Wikipedia + AnySearch (All Free & Unlimited)")
    print(f"🌐 http://0.0.0.0:{port}/")
    print("="*60 + "\n")
    app.run(host='0.0.0.0', port=port, debug=False)