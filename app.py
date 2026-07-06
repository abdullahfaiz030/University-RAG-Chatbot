from pptx import Presentation
import os
import warnings
warnings.filterwarnings('ignore')
os.environ['HF_HUB_DISABLE_SYMLINKS_WARNING'] = '1'
os.environ['TOKENIZERS_PARALLELISM'] = 'false'

from flask import Flask, render_template, request, jsonify, session, redirect, url_for, Response
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
from collections import defaultdict

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
    
    for secret_name in ['GEMINI_API_KEY', 'GROQ_API_KEY', 'SECRET_KEY', 'ADMIN_USERNAME', 'ADMIN_PASSWORD', 
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

gemini_key = os.environ.get('GEMINI_API_KEY', 'NOT SET')
groq_key = os.environ.get('GROQ_API_KEY', 'NOT SET')
print(f"🔑 GEMINI_API_KEY: {'SET' if gemini_key != 'NOT SET' else 'NOT SET'}")
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

# ========== CONVERSATION MEMORY ==========
conversation_sessions = defaultdict(list)
MAX_HISTORY = 20

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

gemini_api_key = os.getenv('GEMINI_API_KEY')
gemini_connected = False

if gemini_api_key:
    gemini_connected = True
    print("✅ Gemini API config found")

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

def gemini_chat_completion(system_prompt, user_prompt, model="gemini-2.0-flash", max_tokens=150, temperature=0.7):
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={gemini_api_key}"
    headers = {
        "Content-Type": "application/json"
    }
    payload = {
        "contents": [
            {
                "role": "user",
                "parts": [
                    {"text": user_prompt}
                ]
            }
        ],
        "generationConfig": {
            "temperature": temperature,
            "maxOutputTokens": max_tokens
        }
    }
    if system_prompt:
        payload["systemInstruction"] = {
            "parts": [
                {"text": system_prompt}
            ]
        }
    
    response = requests.post(url, json=payload, headers=headers, timeout=30)
    if response.status_code == 200:
        data = response.json()
        try:
            return data["candidates"][0]["content"]["parts"][0]["text"]
        except (KeyError, IndexError) as e:
            raise Exception("Unexpected Gemini API response structure")
    else:
        raise Exception(f"Gemini API error: {response.status_code} - {response.text}")


def upload_to_hf_dataset(file_path, filename):
    if not hf_api or not hf_dataset:
        return False
    try:
        path_in_repo = f"documents/{filename}"
        hf_api.upload_file(path_or_fileobj=file_path, path_in_repo=path_in_repo, repo_id=hf_dataset, repo_type="dataset")
        return True
    except:
        return False

# ========== WEB SEARCH ==========

def search_duckduckgo(query):
    try:
        from duckduckgo_search import DDGS
        results = []
        with DDGS() as ddgs:
            for r in list(ddgs.text(query, max_results=3)):
                results.append({"title": r.get("title", ""), "snippet": r.get("body", ""), "link": r.get("href", ""), "source": "DuckDuckGo"})
        return results if results else None
    except:
        return None

def search_wikipedia(query):
    try:
        wiki_url = f"https://en.wikipedia.org/api/rest_v1/page/summary/{requests.utils.quote(query)}"
        wiki_response = requests.get(wiki_url, timeout=8)
        if wiki_response.status_code == 200:
            wiki_data = wiki_response.json()
            return [{"title": wiki_data.get("title", query), "snippet": wiki_data.get("extract", "")[:500], "source": "Wikipedia", "link": wiki_data.get("content_urls", {}).get("desktop", {}).get("page", "")}]
        return None
    except:
        return None

def search_anysearch(query):
    try:
        url = "https://anysearch-mcp.khulnasoft.com/search"
        response = requests.post(url, json={"query": query, "limit": 3}, timeout=10)
        if response.status_code == 200:
            data = response.json()
            results = []
            for item in data.get("results", [])[:3]:
                results.append({"title": item.get("title", ""), "snippet": item.get("snippet", ""), "link": item.get("url", ""), "source": "AnySearch"})
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

def analyze_sentiment(text):
    positive_words = ['thanks', 'great', 'awesome', 'good', 'love', 'excellent', 'wonderful', 'perfect', 'helpful', 'amazing']
    negative_words = ['bad', 'terrible', 'awful', 'hate', 'useless', 'stupid', 'wrong', 'poor', 'frustrating', 'confusing']
    frustrated_words = ['confused', 'dont understand', 'not clear', 'what do you mean', 'explain again', 'still dont get']
    
    text_lower = text.lower()
    pos_count = sum(1 for w in positive_words if w in text_lower)
    neg_count = sum(1 for w in negative_words if w in text_lower)
    frus_count = sum(1 for w in frustrated_words if w in text_lower)
    
    if frus_count > 0: return 'frustrated'
    if neg_count > pos_count: return 'negative'
    if pos_count > 0: return 'positive'
    return 'neutral'

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

def generate_suggestions(user_message, response_text):
    user_lower = user_message.lower()
    if 'what is' in user_lower or 'define' in user_lower:
        return ["Can you give an example?", "Why is this important?", "How does this relate to my course?"]
    elif 'how' in user_lower:
        return ["Can you explain step by step?", "What are the prerequisites?", "Are there any alternatives?"]
    else:
        return ["Can you explain more?", "What's an example of this?", "How is this applied in practice?"]

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
        if not file.filename: continue
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
                    points.append(PointStruct(id=point_id, vector=embedding, payload={
                        "filename": filename, "text": chunk, "chunk_index": i,
                        "category": category, "file_type": file_type,
                        "upload_date": str(pd.Timestamp.now())
                    }))
                
                if qdrant_client:
                    qdrant_client.upsert(collection_name="university_notes", points=points)
                
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
        session_id = data.get('session_id', 'default')
        
        if not user_message:
            return jsonify({'response': 'Please type a message.'}), 400
        if not gemini_api_key and not groq_client:
            return jsonify({'response': 'AI service not available.'}), 500
        
        user_lower = user_message.lower().strip()
        sentiment = analyze_sentiment(user_message)
        
        # ========== DETECT FOLLOW-UP QUESTIONS ==========
        follow_up_phrases = [
            'explain more', 'tell me more', 'give me more', 'elaborate',
            'what about', 'can you explain', 'go deeper', 'more details',
            'more explanation', 'expand', 'further', 'in detail',
            'what else', 'continue', 'and then', 'why is that',
            'how does that', 'can you clarify', 'what does that mean',
            'explain it', 'describe it', 'tell about it', 'what is it',
            'tell me about it', 'elaborate on that', 'go on'
        ]
        is_follow_up = any(phrase in user_lower for phrase in follow_up_phrases) and len(user_message.split()) <= 8
        
        # ========== GET PREVIOUS TOPIC FROM HISTORY ==========
        history = conversation_sessions.get(session_id, [])
        recent_history = ""
        previous_topic = ""
        
        if history:
            last_messages = history[-6:]
            for msg in last_messages:
                role = "User" if msg['role'] == 'user' else "Assistant"
                recent_history += f"{role}: {msg['content']}\n"
            
            # Get the last user question as the previous topic
            last_user_msgs = [m['content'] for m in history if m['role'] == 'user']
            if last_user_msgs:
                previous_topic = last_user_msgs[-1]
        
        # ========== CLASSIFICATION ==========
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
        
        # ========== WEB SEARCH ==========
        web_results = None
        if needs_realtime and not is_casual:
            web_results = search_web(user_message)
        
        # ========== DOCUMENT SEARCH (FIXED FOR FOLLOW-UPS) ==========
        doc_context = ""
        
        if qdrant_client and embedding_model and not is_casual and not web_results:
            # KEY FIX: For follow-ups, search using the PREVIOUS TOPIC
            if is_follow_up and previous_topic:
                search_query = previous_topic
                print(f"🔍 Follow-up detected! Searching for previous topic: '{search_query}'")
            else:
                search_query = user_message
                print(f"🔍 Searching for: '{search_query}'")
            
            try:
                query_embedding = embedding_model.encode(search_query).tolist()
                search_results = qdrant_client.search(
                    collection_name="university_notes", query_vector=query_embedding, limit=3
                )
                if search_results:
                    texts = []
                    for hit in search_results:
                        texts.append(hit.payload.get('text', ''))
                    if texts: 
                        doc_context = "\n\n".join(texts[:3])
                        print(f"✅ Found {len(texts)} document chunks")
            except Exception as e:
                print(f"Search error: {e}")
        
        # ========== BUILD PROMPTS ==========
        
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
        elif sentiment == 'frustrated':
            system_prompt = "The user seems frustrated. Be extra patient and helpful. Break things down simply. Offer to re-explain. 2-3 sentences."
            user_prompt = f"User seems confused: {user_message}\n\nPatient, helpful response:"
            max_tokens = 150
        elif web_results:
            web_context = ""
            for r in web_results[:3]:
                web_context += f"📰 {r.get('title', '')}: {r.get('snippet', '')}\n\n"
            system_prompt = "You are a helpful AI with web access. Answer in 1-3 SHORT sentences. Be direct."
            user_prompt = f"Web results:\n{web_context}\n\nQuestion: {user_message}\n\nShort answer:"
            max_tokens = 120
        elif is_follow_up and doc_context:
            # FOLLOW-UP WITH DOCUMENTS: Previous topic's notes + conversation history
            system_prompt = f"You are a helpful AI tutor. The user is asking a FOLLOW-UP question about: '{previous_topic}'. Look at the conversation history and the reference material to expand on the previous topic. Answer in 2-4 sentences. Be helpful. NEVER mention notes, documents, or files."
            user_prompt = f"PREVIOUS CONVERSATION:\n{recent_history}\n\nReference material about '{previous_topic}':\n{doc_context[:500]}\n\nFollow-up: {user_message}\n\nExpand on '{previous_topic}' in a helpful way:"
            max_tokens = 150
        elif is_follow_up and not doc_context:
            # FOLLOW-UP WITHOUT DOCUMENTS: Use conversation history + AI knowledge
            system_prompt = f"You are a helpful AI tutor. The user is asking a FOLLOW-UP question about: '{previous_topic}'. Use the conversation history and your own knowledge to expand on the topic. Answer in 2-4 sentences."
            user_prompt = f"PREVIOUS CONVERSATION:\n{recent_history}\n\nFollow-up: {user_message}\n\nExpand on '{previous_topic}' using your knowledge:"
            max_tokens = 150
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
        
        if gemini_api_key:
            gemini_models = ["gemini-3.5-flash", "gemini-2.5-flash", "gemini-2.0-flash-lite", "gemini-2.0-flash"]
            for model in gemini_models:
                try:
                    response_text = gemini_chat_completion(
                        system_prompt=system_prompt,
                        user_prompt=user_prompt,
                        model=model,
                        max_tokens=max_tokens,
                        temperature=0.7
                    )
                    if response_text:
                        print(f"✅ Generated response using Gemini ({model})")
                        break
                except Exception as e:
                    print(f"⚠️ Gemini model {model} failed: {e}")
                    continue
        
        if not response_text and groq_client:
            models_to_try = ["llama-3.1-8b-instant", "llama-3.3-70b-versatile", "mixtral-8x7b-32768"]
            if groq_client == "http_fallback":
                for model in models_to_try:
                    try:
                        response_text = groq_chat_completion(
                            messages=[{"role": "system", "content": system_prompt}, {"role": "user", "content": user_prompt}],
                            model=model, max_tokens=max_tokens, temperature=0.7
                        )
                        print(f"✅ Generated response using Groq fallback ({model})")
                        break
                    except: continue
            else:
                for model in models_to_try:
                    try:
                        completion = groq_client.chat.completions.create(
                            model=model,
                            messages=[{"role": "system", "content": system_prompt}, {"role": "user", "content": user_prompt}],
                            temperature=0.7, max_tokens=max_tokens
                        )
                        response_text = completion.choices[0].message.content
                        print(f"✅ Generated response using Groq fallback ({model})")
                        break
                    except: continue
        
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
            
            # Store in conversation history
            conversation_sessions[session_id].append({"role": "user", "content": user_message})
            conversation_sessions[session_id].append({"role": "assistant", "content": response_text})
            if len(conversation_sessions[session_id]) > MAX_HISTORY:
                conversation_sessions[session_id] = conversation_sessions[session_id][-MAX_HISTORY:]
            
            suggestions = generate_suggestions(user_message, response_text)
            
            return jsonify({
                'response': response_text,
                'sources': [],
                'mode': 'followup' if is_follow_up else ('realtime' if web_results else ('study' if doc_context else 'general')),
                'sentiment': sentiment,
                'suggestions': suggestions
            })
        else:
            return jsonify({'response': "I'm having trouble right now. Could you try asking again?"}), 500
            
    except Exception as e:
        print(f"Chat error: {e}")
        return jsonify({'response': "Sorry, I encountered an issue. Please try again!"}), 500

def is_greeting_check(user_lower):
    greetings = ['hi', 'hello', 'hey', 'morning', 'evening', 'sup', 'yo', 'hola']
    return any(user_lower == g or user_lower.startswith(g + ' ') for g in greetings)

@app.route('/export-chat', methods=['POST'])
def export_chat():
    try:
        data = request.json
        session_id = data.get('session_id', 'default')
        format_type = data.get('format', 'txt')
        
        messages = conversation_sessions.get(session_id, [])
        if not messages:
            return jsonify({'error': 'No messages to export'}), 400
        
        if format_type == 'txt':
            text = "📝 Chat Export\n" + "="*50 + "\n\n"
            for msg in messages:
                role = "👤 You" if msg['role'] == 'user' else "🤖 AI"
                text += f"{role}: {msg['content']}\n\n"
            
            return Response(text, mimetype='text/plain', headers={'Content-Disposition': 'attachment;filename=chat_export.txt'})
        elif format_type == 'json':
            return jsonify({'messages': messages, 'exported_at': str(pd.Timestamp.now())})
        else:
            return jsonify({'error': 'Unsupported format'}), 400
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/check-status', methods=['GET'])
def check_status():
    doc_count = 0
    if qdrant_client:
        try:
            info = qdrant_client.get_collection("university_notes")
            doc_count = info.points_count
        except: pass
    return jsonify({
        'status': 'online',
        'documents_available': doc_count > 0,
        'document_count': doc_count,
        'api_connected': gemini_connected or groq_connected,
        'qdrant_connected': qdrant_client is not None,
        'web_search': 'DuckDuckGo + Wikipedia + AnySearch (All Free)',
        'features': ['memory', 'follow_up', 'sentiment', 'suggestions', 'export', 'voice', 'charts', 'multi_language']
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
        except: pass
    return jsonify({'success': True, 'total_documents': doc_count, 'total_chunks': doc_count})

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 7860))
    doc_count = 0
    if qdrant_client:
        try:
            info = qdrant_client.get_collection("university_notes")
            doc_count = info.points_count
        except: pass
    print("\n" + "="*60)
    print("🚀 SERVER STARTED")
    print(f"📚 Documents: {doc_count}")
    print(f"🧠 Memory: {MAX_HISTORY} messages per session")
    print(f"💬 Follow-up Detection: Enabled (searches previous topic)")
    print(f"😊 Sentiment Analysis: Enabled")
    print(f"💡 Smart Suggestions: Enabled")
    print(f"📤 Chat Export: Enabled")
    print(f"🔍 Web Search: DuckDuckGo + Wikipedia + AnySearch (All Free)")
    print(f"🌐 http://0.0.0.0:{port}/")
    print("="*60 + "\n")
    app.run(host='0.0.0.0', port=port, debug=False)