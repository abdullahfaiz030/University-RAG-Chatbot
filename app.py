import os
import sys
import warnings
warnings.filterwarnings('ignore')

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except Exception:
        pass

os.environ['HF_HUB_DISABLE_SYMLINKS_WARNING'] = '1'
os.environ['TOKENIZERS_PARALLELISM'] = 'false'

from pptx import Presentation
from flask import Flask, render_template, request, jsonify, session, redirect, url_for, Response
from werkzeug.utils import secure_filename
from werkzeug.security import generate_password_hash, check_password_hash
try:
    from sentence_transformers import SentenceTransformer
except ImportError:
    SentenceTransformer = None
from qdrant_client import QdrantClient
from qdrant_client.models import Distance, VectorParams, PointStruct
from huggingface_hub import HfApi, InferenceClient
from pymongo import MongoClient
import PyPDF2
import docx
import pandas as pd
from dotenv import load_dotenv
from functools import wraps
import json
from datetime import timedelta, datetime
import traceback
import time
import re
import uuid
import requests
import sqlite3

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
                         'QDRANT_URL', 'QDRANT_API_KEY', 'HF_TOKEN', 'HF_DATASET', 'MONGO_URI']:
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
mongo_uri = os.environ.get('MONGO_URI', 'NOT SET')
print(f"🔑 GEMINI_API_KEY: {'SET' if gemini_key != 'NOT SET' else 'NOT SET'}")
print(f"🔑 GROQ_API_KEY: {'SET' if groq_key != 'NOT SET' else 'NOT SET'}")
print(f"🔑 MONGO_URI: {'SET' if mongo_uri != 'NOT SET' else 'NOT SET'}")
print(f"🔑 QDRANT_URL: {'SET' if os.environ.get('QDRANT_URL') else 'NOT SET'}")

app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = 32 * 1024 * 1024
app.config['UPLOAD_FOLDER'] = 'uploads'
app.secret_key = os.getenv('SECRET_KEY', 'your-secret-key-change-this')
app.permanent_session_lifetime = timedelta(hours=24)

ADMIN_USERNAME = os.getenv('ADMIN_USERNAME', 'admin')
ADMIN_PASSWORD_HASH = generate_password_hash(os.getenv('ADMIN_PASSWORD', 'Admin@123'))

os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)

# ========== MONGODB FOR STUDENT ACCOUNTS & CHAT SESSIONS ==========
mongo_client = None
users_collection = None
sessions_collection = None

try:
    if mongo_uri != 'NOT SET':
        mongo_client = MongoClient(mongo_uri, serverSelectionTimeoutMS=5000)
        db_mongo = mongo_client['chatbot_db']
        users_collection = db_mongo['users']
        sessions_collection = db_mongo['chat_sessions']
        users_collection.create_index('email', unique=True)
        print("✅ MongoDB connected (Users & Chat Sessions)")
    else:
        print("⚠️ MONGO_URI not set - student accounts disabled")
except Exception as e:
    print(f"⚠️ MongoDB connection failed: {e}")

# ========== PERSISTENT CONVERSATION MEMORY (SQLite fallback) ==========
DB_PATH = os.getenv('CHAT_DB_PATH', 'chat_history.db')
MAX_HISTORY = 20

def get_db_connection():
    conn = sqlite3.connect(DB_PATH, check_same_thread=False, timeout=10)
    conn.execute('PRAGMA journal_mode=WAL')
    return conn

def init_db():
    conn = get_db_connection()
    conn.execute('''
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            timestamp TEXT NOT NULL
        )
    ''')
    conn.execute('CREATE INDEX IF NOT EXISTS idx_session_id ON messages(session_id)')
    conn.commit()
    conn.close()

def save_message_sqlite(session_id, role, content):
    conn = get_db_connection()
    try:
        conn.execute(
            'INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)',
            (session_id, role, content, datetime.utcnow().isoformat())
        )
        conn.commit()
    finally:
        conn.close()

def get_session_history_sqlite(session_id, limit=MAX_HISTORY):
    conn = get_db_connection()
    try:
        cur = conn.execute(
            'SELECT role, content FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?',
            (session_id, limit)
        )
        rows = cur.fetchall()
    finally:
        conn.close()
    return [{'role': r, 'content': c} for r, c in reversed(rows)]

def trim_session_history_sqlite(session_id, keep=MAX_HISTORY):
    conn = get_db_connection()
    try:
        conn.execute('''
            DELETE FROM messages
            WHERE session_id = ? AND id NOT IN (
                SELECT id FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?
            )
        ''', (session_id, session_id, keep))
        conn.commit()
    finally:
        conn.close()

def clear_session_history_sqlite(session_id):
    conn = get_db_connection()
    try:
        conn.execute('DELETE FROM messages WHERE session_id = ?', (session_id,))
        conn.commit()
    finally:
        conn.close()

# Main DB methods with MongoDB priority, SQLite fallback

def save_message(session_id, role, content, sources=None):
    if sessions_collection:
        try:
            sessions_collection.update_one(
                {'session_id': session_id},
                {'$push': {'messages': {
                    'role': role, 'content': content,
                    'sources': sources or [], 'timestamp': datetime.utcnow()
                }}},
                upsert=True
            )
            return
        except Exception as e:
            print(f"MongoDB save error: {e}")
    save_message_sqlite(session_id, role, content)

def get_session_history(session_id, limit=MAX_HISTORY):
    if sessions_collection:
        try:
            doc = sessions_collection.find_one({'session_id': session_id})
            if doc and 'messages' in doc:
                messages = doc['messages'][-limit:]
                return [{'role': m['role'], 'content': m['content']} for m in messages]
        except Exception as e:
            print(f"MongoDB get error: {e}")
    return get_session_history_sqlite(session_id, limit)

def trim_session_history(session_id, keep=MAX_HISTORY):
    if sessions_collection:
        try:
            doc = sessions_collection.find_one({'session_id': session_id})
            if doc and 'messages' in doc and len(doc['messages']) > keep:
                sessions_collection.update_one(
                    {'session_id': session_id},
                    {'$push': {'messages': {'$each': [], '$slice': -keep}}}
                )
            return
        except Exception as e:
            print(f"MongoDB trim error: {e}")
    trim_session_history_sqlite(session_id, keep)

def clear_session_history(session_id):
    if sessions_collection:
        try:
            sessions_collection.delete_one({'session_id': session_id})
            return
        except Exception as e:
            print(f"MongoDB clear error: {e}")
    clear_session_history_sqlite(session_id)

init_db()

print("\n" + "="*60)
print("🔄 INITIALIZING...")
print("="*60)

class HFEmbeddingModel:
    def __init__(self, model_name="sentence-transformers/all-MiniLM-L6-v2", token=None):
        self.model_name = model_name
        self.token = token
        self.local_model = None
        self.client = None
        
        if SentenceTransformer is not None:
            try:
                self.local_model = SentenceTransformer(self.model_name)
                print(f"✅ Loaded local SentenceTransformer model: {self.model_name}")
            except Exception as e:
                print(f"⚠️ Could not load local SentenceTransformer: {e}. Falling back to Hugging Face Inference API.")
        else:
            print("⚠️ sentence-transformers package not installed. Falling back to Hugging Face Inference API.")
            
        if self.local_model is None:
            self.client = InferenceClient(token=self.token)
            print("✅ Initialized Hugging Face InferenceClient")

    def encode(self, sentences, **kwargs):
        if self.local_model:
            return self.local_model.encode(sentences, **kwargs)
            
        if not self.client:
            self.client = InferenceClient(token=self.token)
            
        try:
            import numpy as np
            if isinstance(sentences, str):
                res = self.client.feature_extraction(text=sentences, model=self.model_name)
                if isinstance(res, np.ndarray):
                    return res
                return np.array(res)
            else:
                results = []
                for s in sentences:
                    res = self.client.feature_extraction(text=s, model=self.model_name)
                    if isinstance(res, np.ndarray):
                        results.append(res)
                    else:
                        results.append(np.array(res))
                return np.stack(results)
        except Exception as e:
            print(f"❌ Error during HF Inference API feature extraction: {e}")
            import numpy as np
            if isinstance(sentences, str):
                return np.zeros(384)
            else:
                return np.zeros((len(sentences), 384))

try:
    hf_token = os.getenv('HF_TOKEN')
    embedding_model = HFEmbeddingModel(token=hf_token)
    print("✅ Hybrid embedding model loaded successfully")
except Exception as e:
    embedding_model = None
    print(f"❌ Embedding failed: {e}")

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
gemini_connected = bool(gemini_api_key)
groq_api_key = os.getenv('GROQ_API_KEY')
groq_connected = bool(groq_api_key)

if gemini_connected:
    print("✅ Gemini API key found")
if groq_connected:
    print("✅ Groq API key found")
if not gemini_connected and not groq_connected:
    print("❌ No AI API keys found!")

print("="*60 + "\n")

def admin_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if 'admin_logged_in' not in session:
            return redirect(url_for('admin_login_page'))
        return f(*args, **kwargs)
    return decorated_function

def login_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if 'student_user' not in session:
            return redirect(url_for('login_page'))
        return f(*args, **kwargs)
    return decorated_function

# ========== FILE EXTRACTION ==========

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

# ========== API CLIENTS ==========

GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
GROQ_MODELS = ["llama-3.1-8b-instant", "llama-3.3-70b-versatile", "mixtral-8x7b-32768"]
GEMINI_MODELS = ["gemini-2.0-flash", "gemini-2.0-flash-lite"]

def groq_chat_completion(messages, model="llama-3.1-8b-instant", max_tokens=150, temperature=0.7):
    headers = {"Authorization": f"Bearer {groq_api_key}", "Content-Type": "application/json"}
    payload = {"model": model, "messages": messages, "max_tokens": max_tokens, "temperature": temperature}
    response = requests.post(GROQ_URL, json=payload, headers=headers, timeout=30)
    if response.status_code == 200:
        return response.json()["choices"][0]["message"]["content"]
    raise Exception(f"Groq API error: {response.status_code}")

def groq_chat_completion_stream(messages, model="llama-3.1-8b-instant", max_tokens=150, temperature=0.7):
    headers = {"Authorization": f"Bearer {groq_api_key}", "Content-Type": "application/json"}
    payload = {"model": model, "messages": messages, "max_tokens": max_tokens, "temperature": temperature, "stream": True}
    with requests.post(GROQ_URL, json=payload, headers=headers, timeout=30, stream=True) as response:
        if response.status_code != 200:
            raise Exception(f"Groq API error: {response.status_code}")
        for raw_line in response.iter_lines():
            if not raw_line: continue
            line = raw_line.decode('utf-8')
            if not line.startswith('data: '): continue
            payload_str = line[len('data: '):].strip()
            if payload_str == '[DONE]': break
            try:
                chunk = json.loads(payload_str)
                delta = chunk.get('choices', [{}])[0].get('delta', {}).get('content', '')
                if delta: yield delta
            except (json.JSONDecodeError, IndexError, KeyError): continue

def build_gemini_contents(history_messages, user_prompt):
    contents = []
    for msg in history_messages:
        role = "user" if msg['role'] == 'user' else "model"
        contents.append({"role": role, "parts": [{"text": msg['content']}]})
    contents.append({"role": "user", "parts": [{"text": user_prompt}]})
    return contents

def gemini_chat_completion(system_prompt, contents, model="gemini-2.0-flash", max_tokens=150, temperature=0.7):
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={gemini_key}"
    headers = {"Content-Type": "application/json"}
    payload = {"contents": contents, "generationConfig": {"temperature": temperature, "maxOutputTokens": max_tokens}}
    if system_prompt:
        payload["systemInstruction"] = {"parts": [{"text": system_prompt}]}
    response = requests.post(url, json=payload, headers=headers, timeout=30)
    if response.status_code == 200:
        data = response.json()
        try:
            return data["candidates"][0]["content"]["parts"][0]["text"]
        except (KeyError, IndexError):
            raise Exception("Unexpected Gemini API response structure")
    raise Exception(f"Gemini API error: {response.status_code}")

def gemini_chat_completion_stream(system_prompt, contents, model="gemini-2.0-flash", max_tokens=150, temperature=0.7):
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse&key={gemini_key}"
    headers = {"Content-Type": "application/json"}
    payload = {"contents": contents, "generationConfig": {"temperature": temperature, "maxOutputTokens": max_tokens}}
    if system_prompt:
        payload["systemInstruction"] = {"parts": [{"text": system_prompt}]}
    with requests.post(url, json=payload, headers=headers, timeout=30, stream=True) as response:
        if response.status_code != 200:
            raise Exception(f"Gemini API error: {response.status_code}")
        for raw_line in response.iter_lines():
            if not raw_line: continue
            line = raw_line.decode('utf-8')
            if not line.startswith('data: '): continue
            payload_str = line[len('data: '):].strip()
            try:
                chunk = json.loads(payload_str)
                delta = chunk["candidates"][0]["content"]["parts"][0]["text"]
                if delta: yield delta
            except (json.JSONDecodeError, KeyError, IndexError): continue

# ========== WEB SEARCH ==========

def search_duckduckgo(query):
    try:
        from duckduckgo_search import DDGS
        results = []
        with DDGS() as ddgs:
            for r in list(ddgs.text(query, max_results=3)):
                results.append({"title": r.get("title", ""), "snippet": r.get("body", ""), "link": r.get("href", ""), "source": "DuckDuckGo"})
        return results if results else None
    except: return None

def search_wikipedia(query):
    try:
        wiki_url = f"https://en.wikipedia.org/api/rest_v1/page/summary/{requests.utils.quote(query)}"
        wiki_response = requests.get(wiki_url, timeout=8)
        if wiki_response.status_code == 200:
            wiki_data = wiki_response.json()
            return [{"title": wiki_data.get("title", query), "snippet": wiki_data.get("extract", "")[:500], "source": "Wikipedia", "link": wiki_data.get("content_urls", {}).get("desktop", {}).get("page", "")}]
        return None
    except: return None

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
    except: return None

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
    real_time_indicators = ['current', 'latest', 'today', 'now', '2024', '2025', '2026', 'president', 'prime minister', 'election', 'news', 'recent', 'weather', 'stock', 'price', 'score', 'live', 'update', 'who is the', 'who is current', 'currently', 'right now', 'who is president', 'who is prime minister', 'who leads', 'leader of', 'head of state', 'who governs', 'what is the capital', 'population of', 'weather in']
    return any(indicator in user_lower for indicator in real_time_indicators)

def generate_suggestions(user_message, response_text):
    user_lower = user_message.lower()
    if 'what is' in user_lower or 'define' in user_lower:
        return ["Can you give an example?", "Why is this important?", "How does this relate to my course?"]
    elif 'how' in user_lower:
        return ["Can you explain step by step?", "What are the prerequisites?", "Are there any alternatives?"]
    else:
        return ["Can you explain more?", "What's an example of this?", "How is this applied in practice?"]

# ========== SHARED PROMPT-BUILDING LOGIC ==========

def build_chat_context(user_message, session_id, length_control='medium', uploaded_context="", uploaded_filenames=None):
    user_lower = user_message.lower().strip()
    sentiment = analyze_sentiment(user_message)

    follow_up_phrases = ['explain more', 'tell me more', 'give me more', 'elaborate', 'what about', 'can you explain', 'go deeper', 'more details', 'more explanation', 'expand', 'further', 'in detail', 'what else', 'continue', 'and then', 'why is that', 'how does that', 'can you clarify', 'what does that mean', 'explain it', 'describe it', 'tell about it', 'what is it', 'tell me about it', 'elaborate on that', 'go on']
    is_follow_up = any(phrase in user_lower for phrase in follow_up_phrases) and len(user_message.split()) <= 8

    history = get_session_history(session_id)
    recent_history = ""
    previous_topic = ""
    history_messages = []

    if history:
        last_messages = history[-6:]
        for msg in last_messages:
            role = "User" if msg['role'] == 'user' else "Assistant"
            recent_history += f"{role}: {msg['content']}\n"
        last_user_msgs = [m['content'] for m in history if m['role'] == 'user']
        if last_user_msgs: previous_topic = last_user_msgs[-1]
        history_messages = history[-10:]

    greetings = ['hi', 'hello', 'hey', 'good morning', 'good afternoon', 'good evening', 'sup', 'yo', 'hola', 'hii', 'heyy', 'helloo', 'morning', 'evening', 'good day']
    is_greeting = any(user_lower == g or user_lower.startswith(g + ' ') for g in greetings) and len(user_message.split()) <= 3

    identity_q = ['who are you', 'what are you', 'your name', 'about yourself', 'introduce yourself', 'tell me about yourself', 'who created you', 'are you ai', 'are you human', 'are you real']
    location_q = ['where are you', 'where do you live', 'your country', 'which country', 'where you from', 'your location']
    user_personal_q = ['know my name', 'do you know me', 'who am i', 'what is my name', 'remember me']
    is_identity = any(q in user_lower for q in identity_q)
    is_location = any(q in user_lower for q in location_q)
    is_user_personal = any(q in user_lower for q in user_personal_q)
    is_about_ai = is_identity or is_location

    thanks_words = ['thank', 'thanks', 'thx', 'appreciate']
    is_thanks = any(t in user_lower for t in thanks_words) and len(user_message.split()) <= 4

    needs_realtime = needs_real_time_info(user_message)
    is_casual = is_greeting or is_thanks or is_about_ai or is_user_personal

    web_results = None
    sources = []
    if needs_realtime and not is_casual:
        web_results = search_web(user_message)
        if web_results:
            sources = [r.get('title', '') for r in web_results[:3] if r.get('title')]

    doc_context = ""
    if qdrant_client and embedding_model and not is_casual and not web_results:
        search_query = previous_topic if (is_follow_up and previous_topic) else user_message
        try:
            query_embedding = embedding_model.encode(search_query).tolist()
            search_results = qdrant_client.search(collection_name="university_notes", query_vector=query_embedding, limit=3)
            if search_results:
                texts = [hit.payload.get('text', '') for hit in search_results]
                if texts: doc_context = "\n\n".join(texts[:3])
                doc_names = [hit.payload.get('filename', '') for hit in search_results if hit.payload.get('filename')]
                sources = list(dict.fromkeys(doc_names))
        except Exception as e: print(f"Search error: {e}")

    if uploaded_context:
        doc_context = uploaded_context + "\n" + doc_context
    if uploaded_filenames:
        sources = list(dict.fromkeys(sources + uploaded_filenames))

    # Build prompts
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
        system_prompt = "The user seems frustrated. Be extra patient and helpful. 2-3 sentences."
        user_prompt = f"User seems confused: {user_message}\n\nPatient, helpful response:"
        max_tokens = 150
    elif web_results:
        web_context = "".join([f"📰 {r.get('title', '')}: {r.get('snippet', '')}\n\n" for r in web_results[:3]])
        system_prompt = "You are a helpful AI with web access. Answer in 1-3 SHORT sentences. Be direct."
        user_prompt = f"Web results:\n{web_context}\n\nQuestion: {user_message}\n\nShort answer:"
        max_tokens = 120
    elif is_follow_up and doc_context:
        system_prompt = f"You are a helpful AI tutor. The user is asking a FOLLOW-UP about: '{previous_topic}'. Expand on it. 3-5 sentences. NEVER mention notes or documents."
        user_prompt = f"Reference about '{previous_topic}':\n{doc_context[:500]}\n\nUser: {user_message}\n\nExpand on '{previous_topic}':"
        max_tokens = 200
    elif is_follow_up and not doc_context:
        system_prompt = f"You are a helpful AI tutor. The user is asking a FOLLOW-UP about: '{previous_topic}'. Expand on it. 3-5 sentences."
        user_prompt = f"Previous topic: '{previous_topic}'. User: {user_message}\n\nExpand on '{previous_topic}':"
        max_tokens = 200
    elif doc_context:
        system_prompt = "You are a helpful AI tutor. Answer in 1-3 SHORT sentences. NEVER mention notes or documents."
        user_prompt = f"Reference (read silently):\n{doc_context[:500]}\n\nQuestion: {user_message}\n\nShort answer:"
        max_tokens = 100
    else:
        system_prompt = "You are a smart AI assistant. Answer in 1-3 SHORT sentences."
        user_prompt = f"Question: {user_message}\n\nShort answer:"
        max_tokens = 100

    if length_control == 'short':
        system_prompt += " IMPORTANT: Keep response extremely short and concise (1 sentence max)."
        max_tokens = 80
    elif length_control == 'detailed':
        system_prompt += " Provide a detailed explanation with formatting, bullet points, or code blocks where relevant."
        max_tokens = 1000
    else:
        system_prompt += " Keep response to a medium length (2-4 sentences max)."
        max_tokens = 250

    return {
        'system_prompt': system_prompt, 'user_prompt': user_prompt, 'max_tokens': max_tokens,
        'mode': 'followup' if is_follow_up else ('realtime' if web_results else ('study' if doc_context else 'general')),
        'sentiment': sentiment, 'is_greeting': is_greeting, 'is_thanks': is_thanks,
        'is_follow_up': is_follow_up, 'history_messages': history_messages, 'sources': sources,
    }

def postprocess_response(text, ctx):
    if not text: return "How can I help you today?"
    text = re.sub(r'\*{1,3}', '', text)
    text = re.sub(r'#{1,4}\s*', '', text)
    text = text.strip()
    if ctx['is_greeting'] and (len(text) < 2 or len(text) > 60):
        text = "Hey there! 👋 How can I help you today?"
    if ctx['is_thanks'] and len(text) > 30:
        text = "You're welcome! 😊"
    return text if len(text) >= 2 else "How can I help you today?"

# ==================== ROUTES ====================

@app.route('/')
@login_required
def index():
    return render_template('index.html')

# ========== STUDENT AUTH (MongoDB) ==========

@app.route('/login', methods=['GET', 'POST'])
def login_page():
    if request.method == 'POST':
        if not users_collection:
            return jsonify({'success': False, 'message': 'User system not available'}), 500
        
        data = request.json or {}
        email = data.get('email', '').strip().lower()
        password = data.get('password', '')
        
        if not email or not password:
            return jsonify({'success': False, 'message': 'Email and password required'}), 400
        
        user = users_collection.find_one({'email': email})
        if user and check_password_hash(user['password_hash'], password):
            session.permanent = True
            session['student_user'] = {
                'id': str(user['_id']),
                'email': email,
                'name': user.get('name', email)
            }
            return jsonify({'success': True})
        
        return jsonify({'success': False, 'message': 'Invalid email or password'}), 401
    
    if 'student_user' in session:
        return redirect(url_for('index'))
    return render_template('login.html')

@app.route('/signup', methods=['GET', 'POST'])
def signup_page():
    if request.method == 'POST':
        if not users_collection:
            return jsonify({'success': False, 'message': 'User system not available'}), 500
        
        data = request.json or {}
        name = data.get('name', '').strip()
        email = data.get('email', '').strip().lower()
        password = data.get('password', '')
        
        if not name or not email or not password:
            return jsonify({'success': False, 'message': 'All fields required'}), 400
        if len(password) < 6:
            return jsonify({'success': False, 'message': 'Password must be 6+ characters'}), 400
        if users_collection.find_one({'email': email}):
            return jsonify({'success': False, 'message': 'Email already registered'}), 400
        
        users_collection.insert_one({
            'name': name, 'email': email,
            'password_hash': generate_password_hash(password),
            'created_at': datetime.utcnow()
        })
        
        print(f"✅ New student: {name} ({email})")
        return jsonify({'success': True, 'message': 'Registration successful! Please login.'})
    
    if 'student_user' in session:
        return redirect(url_for('index'))
    return render_template('signup.html')

@app.route('/logout')
def logout():
    session.pop('student_user', None)
    return redirect(url_for('login_page'))

# ========== CHAT SESSION MANAGEMENT (MongoDB) ==========

@app.route('/api/sessions', methods=['GET'])
@login_required
def api_get_sessions():
    if not sessions_collection:
        return jsonify({'success': True, 'sessions': []})
    
    try:
        docs = sessions_collection.find({'user_email': session['student_user']['email']})
        sessions_data = []
        for doc in docs:
            messages = doc.get('messages', [])
            sessions_data.append({
                'id': doc['session_id'],
                'title': doc.get('title', 'New Chat'),
                'messages': [{'role': m['role'], 'content': m['content']} for m in messages],
                'timestamp': str(doc.get('_id').generation_time) if doc.get('_id') else ''
            })
        return jsonify({'success': True, 'sessions': sessions_data})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)}), 500

@app.route('/api/sessions', methods=['POST'])
@login_required
def api_create_session():
    data = request.json or {}
    session_id = data.get('id')
    title = data.get('title', 'New Chat')
    if not session_id:
        return jsonify({'success': False, 'message': 'Session ID required'}), 400
    if sessions_collection:
        try:
            sessions_collection.update_one(
                {'session_id': session_id},
                {'$set': {'user_email': session['student_user']['email'], 'title': title}},
                upsert=True
            )
        except Exception as e:
            return jsonify({'success': False, 'message': str(e)}), 500
    return jsonify({'success': True})

@app.route('/api/sessions/update-title', methods=['POST'])
@login_required
def api_update_session_title():
    data = request.json or {}
    session_id = data.get('id')
    title = data.get('title')
    if not session_id or not title:
        return jsonify({'success': False, 'message': 'Session ID and title required'}), 400
    if sessions_collection:
        sessions_collection.update_one({'session_id': session_id}, {'$set': {'title': title}})
    return jsonify({'success': True})

@app.route('/api/sessions/<session_id>', methods=['DELETE'])
@login_required
def api_delete_session(session_id):
    if sessions_collection:
        sessions_collection.delete_one({'session_id': session_id})
    return jsonify({'success': True})

# ========== ADMIN ROUTES ==========

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
            elif file_type in ['pptx', 'ppt']: text = extract_text_from_pptx(file_path)
            elif file_type == 'docx': text = extract_text_from_docx(file_path)
            elif file_type == 'txt': text = extract_text_from_txt(file_path)
            elif file_type in ['csv', 'xlsx', 'xls']:
                try: text = pd.read_csv(file_path).to_string() if file_type == 'csv' else pd.read_excel(file_path).to_string()
                except: text = ""
            else: text = extract_text_from_txt(file_path)
            text = clean_text(text)
            if text and len(text.strip()) > 50:
                chunks = chunk_text(text)
                points = []
                for i, chunk in enumerate(chunks):
                    embedding = embedding_model.encode(chunk).tolist()
                    points.append(PointStruct(id=str(uuid.uuid4()), vector=embedding, payload={
                        "filename": filename, "text": chunk, "chunk_index": i,
                        "category": category, "file_type": file_type, "upload_date": str(pd.Timestamp.now())
                    }))
                if qdrant_client: qdrant_client.upsert(collection_name="university_notes", points=points)
                uploaded.append({'name': filename, 'type': file_type.upper(), 'chunks': len(chunks)})
            else: failed.append({'name': filename, 'reason': 'No text extracted'})
            if os.path.exists(file_path): os.remove(file_path)
        except Exception as e: failed.append({'name': file.filename, 'reason': str(e)})
    return jsonify({'success': True, 'uploaded': uploaded, 'failed': failed})

@app.route('/chat', methods=['POST'])
@login_required
def chat():
    try:
        uploaded_context = ""
        uploaded_filenames = []
        if request.content_type and 'multipart/form-data' in request.content_type:
            user_message = request.form.get('message', '').strip()
            session_id = request.form.get('session_id', 'default')
            length_control = request.form.get('length_control', 'medium')
            files = request.files.getlist('files')
        else:
            data = request.get_json(silent=True) or {}
            user_message = data.get('message', '').strip()
            session_id = data.get('session_id', 'default')
            length_control = data.get('length_control', 'medium')
            files = []

        for file in files:
            if not file.filename: continue
            try:
                filename = secure_filename(file.filename)
                file_path = os.path.join(app.config['UPLOAD_FOLDER'], f"temp_{uuid.uuid4()}_{filename}")
                file.save(file_path)
                file_type = filename.split('.')[-1].lower()
                if file_type == 'pdf': file_text = extract_text_from_pdf(file_path)
                elif file_type == 'pptx': file_text = extract_text_from_pptx(file_path)
                elif file_type == 'docx': file_text = extract_text_from_docx(file_path)
                elif file_type == 'txt': file_text = extract_text_from_txt(file_path)
                else: file_text = extract_text_from_txt(file_path)
                file_text = clean_text(file_text)
                if file_text:
                    uploaded_context += f"--- Content from uploaded file '{filename}' ---\n{file_text}\n\n"
                    uploaded_filenames.append(filename)
                if os.path.exists(file_path): os.remove(file_path)
            except Exception as e: print(f"Error processing temp upload: {e}")

        if not user_message and uploaded_filenames:
            user_message = f"Describe the attached file: {', '.join(uploaded_filenames)}"

        if not user_message: return jsonify({'response': 'Please type a message.'}), 400
        if not gemini_api_key and not groq_api_key: return jsonify({'response': 'AI service not available.'}), 500

        ctx = build_chat_context(user_message, session_id, length_control, uploaded_context, uploaded_filenames)
        response_text = None

        if gemini_api_key:
            contents = build_gemini_contents(ctx.get('history_messages', []), ctx['user_prompt'])
            for model in GEMINI_MODELS:
                try:
                    response_text = gemini_chat_completion(system_prompt=ctx['system_prompt'], contents=contents, model=model, max_tokens=ctx['max_tokens'], temperature=0.7)
                    if response_text: break
                except: continue

        if not response_text and groq_api_key:
            messages = [{"role": "system", "content": ctx['system_prompt']}]
            if ctx.get('history_messages'): messages.extend(ctx['history_messages'])
            messages.append({"role": "user", "content": ctx['user_prompt']})
            for model in GROQ_MODELS:
                try:
                    response_text = groq_chat_completion(messages=messages, model=model, max_tokens=ctx['max_tokens'], temperature=0.7)
                    break
                except: continue

        if response_text:
            response_text = postprocess_response(response_text, ctx)
            save_message(session_id, 'user', user_message)
            save_message(session_id, 'assistant', response_text)
            trim_session_history(session_id)
            suggestions = generate_suggestions(user_message, response_text)
            return jsonify({'response': response_text, 'sources': ctx.get('sources', []), 'mode': ctx['mode'], 'sentiment': ctx['sentiment'], 'suggestions': suggestions})
        else:
            return jsonify({'response': "I'm having trouble. Try again!"}), 500
    except Exception as e:
        print(f"Chat error: {e}")
        return jsonify({'response': "Sorry, an error occurred."}), 500

@app.route('/chat/stream', methods=['POST'])
@login_required
def chat_stream():
    uploaded_context, uploaded_filenames = "", []
    if request.content_type and 'multipart/form-data' in request.content_type:
        user_message = request.form.get('message', '').strip()
        session_id = request.form.get('session_id', 'default')
        length_control = request.form.get('length_control', 'medium')
        files = request.files.getlist('files')
    else:
        data = request.get_json(silent=True) or {}
        user_message = data.get('message', '').strip()
        session_id = data.get('session_id', 'default')
        length_control = data.get('length_control', 'medium')
        files = []

    for file in files:
        if not file.filename: continue
        try:
            filename = secure_filename(file.filename)
            file_path = os.path.join(app.config['UPLOAD_FOLDER'], f"temp_{uuid.uuid4()}_{filename}")
            file.save(file_path)
            file_type = filename.split('.')[-1].lower()
            if file_type == 'pdf': file_text = extract_text_from_pdf(file_path)
            elif file_type == 'pptx': file_text = extract_text_from_pptx(file_path)
            elif file_type == 'docx': file_text = extract_text_from_docx(file_path)
            elif file_type == 'txt': file_text = extract_text_from_txt(file_path)
            else: file_text = extract_text_from_txt(file_path)
            file_text = clean_text(file_text)
            if file_text:
                uploaded_context += f"--- Content from uploaded file '{filename}' ---\n{file_text}\n\n"
                uploaded_filenames.append(filename)
            if os.path.exists(file_path): os.remove(file_path)
        except Exception as e: print(f"Error processing temp upload: {e}")

    if not user_message and uploaded_filenames:
        user_message = f"Describe the attached file: {', '.join(uploaded_filenames)}"

    if not user_message: return jsonify({'error': 'Please type a message.'}), 400
    if not gemini_api_key and not groq_api_key: return jsonify({'error': 'AI service not available.'}), 500

    ctx = build_chat_context(user_message, session_id, length_control, uploaded_context, uploaded_filenames)

    def event_stream():
        full_response = ""
        streamed_ok = False
        if gemini_api_key:
            contents = build_gemini_contents(ctx.get('history_messages', []), ctx['user_prompt'])
            for model in GEMINI_MODELS:
                try:
                    for delta in gemini_chat_completion_stream(system_prompt=ctx['system_prompt'], contents=contents, model=model, max_tokens=ctx['max_tokens'], temperature=0.7):
                        full_response += delta
                        yield f"data: {json.dumps({'delta': delta})}\n\n"
                    streamed_ok = True
                    break
                except: full_response = ""

        if not streamed_ok and groq_api_key:
            messages = [{"role": "system", "content": ctx['system_prompt']}]
            if ctx.get('history_messages'): messages.extend(ctx['history_messages'])
            messages.append({"role": "user", "content": ctx['user_prompt']})
            for model in GROQ_MODELS:
                try:
                    for delta in groq_chat_completion_stream(messages=messages, model=model, max_tokens=ctx['max_tokens'], temperature=0.7):
                        full_response += delta
                        yield f"data: {json.dumps({'delta': delta})}\n\n"
                    streamed_ok = True
                    break
                except: full_response = ""

        if not streamed_ok:
            yield f"data: {json.dumps({'error': 'AI service is having trouble.'})}\n\n"
            return

        clean_response = postprocess_response(full_response, ctx)
        save_message(session_id, 'user', user_message)
        save_message(session_id, 'assistant', clean_response)
        trim_session_history(session_id)
        suggestions = generate_suggestions(user_message, clean_response)
        yield f"data: {json.dumps({'done': True, 'mode': ctx['mode'], 'sentiment': ctx['sentiment'], 'suggestions': suggestions, 'sources': ctx.get('sources', [])})}\n\n"

    return Response(event_stream(), mimetype='text/event-stream', headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no', 'Connection': 'keep-alive'})

# ========== SPECIAL FEATURES ==========

@app.route('/generate-flashcards', methods=['POST'])
@login_required
def generate_flashcards():
    try:
        data = request.json or {}
        custom_topic = data.get('topic', '').strip()
        if not gemini_api_key and not groq_api_key: return jsonify({'error': 'AI service not available.'}), 500
        doc_context = ""
        if qdrant_client and embedding_model:
            try:
                if custom_topic:
                    query_embedding = embedding_model.encode(custom_topic).tolist()
                    results = qdrant_client.search(collection_name="university_notes", query_vector=query_embedding, limit=4)
                    if results: doc_context = "\n\n".join([h.payload.get('text', '') for h in results])
                else:
                    results = qdrant_client.scroll(collection_name="university_notes", limit=5)
                    if results[0]: doc_context = "\n\n".join([h.payload.get('text', '') for h in results[0]])
            except Exception as e: print(f"Flashcards search error: {e}")
        system_prompt = "Generate exactly 10 flashcards. Respond ONLY with a valid JSON array: [{\"question\": \"...\", \"answer\": \"...\"}]"
        user_prompt = f"Generate 10 flashcards. Topic: {custom_topic or 'General'}"
        if doc_context: user_prompt += f"\n\nContext:\n{doc_context[:2000]}"
        response_text = None
        if gemini_api_key:
            for model in GEMINI_MODELS:
                try:
                    response_text = gemini_chat_completion(system_prompt=system_prompt, contents=[{"role": "user", "parts": [{"text": user_prompt}]}], model=model, max_tokens=1000, temperature=0.7)
                    if response_text: break
                except: continue
        if not response_text and groq_api_key:
            for model in GROQ_MODELS:
                try:
                    response_text = groq_chat_completion(messages=[{"role": "system", "content": system_prompt}, {"role": "user", "content": user_prompt}], model=model, max_tokens=1000, temperature=0.7)
                    break
                except: continue
        if not response_text: return jsonify({'error': 'Failed to generate flashcards.'}), 500
        raw = response_text.strip()
        if raw.startswith("```"): raw = re.sub(r'^```(?:json)?\n', '', raw); raw = re.sub(r'\n```$', '', raw)
        try:
            flashcards = json.loads(raw)
            if isinstance(flashcards, list) and len(flashcards) > 0:
                return jsonify({'success': True, 'flashcards': flashcards})
        except:
            try:
                match = re.search(r'\[\s*\{.*\}\s*\]', raw, re.DOTALL)
                if match: flashcards = json.loads(match.group(0)); return jsonify({'success': True, 'flashcards': flashcards})
            except: pass
        return jsonify({'success': True, 'flashcards': [{"question": "What is a project?", "answer": "A temporary endeavor to create a unique product or service."}], 'note': 'Using fallback cards'})
    except Exception as e:
        print(f"Flashcards error: {e}")
        return jsonify({'error': 'An internal error occurred.'}), 500

@app.route('/generate-summary', methods=['POST'])
@login_required
def generate_summary():
    try:
        data = request.json or {}
        topic = data.get('topic', '').strip()
        if not topic: return jsonify({'error': 'Please provide a topic.'}), 400
        if not gemini_api_key and not groq_api_key: return jsonify({'error': 'AI service not available.'}), 500
        doc_context = ""
        if qdrant_client and embedding_model:
            try:
                query_embedding = embedding_model.encode(topic).tolist()
                results = qdrant_client.search(collection_name="university_notes", query_vector=query_embedding, limit=6)
                if results: doc_context = "\n\n".join([h.payload.get('text', '') for h in results])
            except: pass
        if not doc_context: return jsonify({'error': 'No relevant documents found.'}), 404
        system_prompt = "You are an academic summarizer. Create a structured Markdown summary with headings, subheadings, and bullet points."
        user_prompt = f"Topic: {topic}\n\nNotes:\n{doc_context[:3000]}\n\nSummary:"
        response_text = None
        if gemini_api_key:
            for model in GEMINI_MODELS:
                try:
                    response_text = gemini_chat_completion(system_prompt=system_prompt, contents=[{"role": "user", "parts": [{"text": user_prompt}]}], model=model, max_tokens=1500, temperature=0.5)
                    if response_text: break
                except: continue
        if not response_text and groq_api_key:
            for model in GROQ_MODELS:
                try:
                    response_text = groq_chat_completion(messages=[{"role": "system", "content": system_prompt}, {"role": "user", "content": user_prompt}], model=model, max_tokens=1500, temperature=0.5)
                    break
                except: continue
        if response_text: return jsonify({'success': True, 'summary': response_text.strip()})
        return jsonify({'error': 'Failed to generate summary.'}), 500
    except Exception as e:
        print(f"Summary error: {e}")
        return jsonify({'error': 'An internal error occurred.'}), 500

@app.route('/clear-history', methods=['POST'])
def clear_history():
    data = request.json or {}
    clear_session_history(data.get('session_id', 'default'))
    return jsonify({'success': True})

@app.route('/export-chat', methods=['POST'])
def export_chat():
    try:
        data = request.json
        session_id = data.get('session_id', 'default')
        format_type = data.get('format', 'txt')
        messages = get_session_history(session_id, limit=10000)
        if not messages: return jsonify({'error': 'No messages'}), 400
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
        try: doc_count = qdrant_client.get_collection("university_notes").points_count
        except: pass
    user_count = users_collection.count_documents({}) if users_collection else 0
    return jsonify({
        'status': 'online', 'documents_available': doc_count > 0, 'document_count': doc_count,
        'api_connected': gemini_connected or groq_connected, 'qdrant_connected': qdrant_client is not None,
        'user_system': users_collection is not None, 'total_users': user_count,
        'features': ['persistent_memory', 'streaming', 'follow_up', 'flashcards', 'summaries', 'sentiment', 'suggestions', 'export']
    })

@app.route('/admin/documents', methods=['GET'])
@admin_required
def get_documents():
    docs = []
    if qdrant_client:
        try:
            scroll_results = qdrant_client.scroll(collection_name="university_notes", limit=100, with_payload=True, with_vectors=False)
            seen = set()
            for point in scroll_results[0]:
                filename = point.payload.get('filename', '')
                if filename and filename not in seen:
                    seen.add(filename)
                    docs.append({'filename': filename, 'file_type': point.payload.get('file_type', ''), 'category': point.payload.get('category', ''), 'upload_date': point.payload.get('upload_date', ''), 'doc_id': point.id, 'chunks': 1})
        except: pass
    return jsonify({'success': True, 'documents': docs})

@app.route('/admin/delete/<doc_id>', methods=['DELETE'])
@admin_required
def delete_document(doc_id):
    try:
        if qdrant_client:
            qdrant_client.delete(collection_name="university_notes", points_selector=[doc_id])
        return jsonify({'success': True})
    except Exception as e:
        print(f"Delete document error: {e}")
        return jsonify({'success': False, 'message': str(e)}), 500

@app.route('/admin/stats')
@admin_required
def get_admin_stats():
    doc_count = 0
    if qdrant_client:
        try: doc_count = qdrant_client.get_collection("university_notes").points_count
        except: pass
    user_count = users_collection.count_documents({}) if users_collection else 0
    return jsonify({'success': True, 'total_documents': doc_count, 'total_chunks': doc_count, 'total_users': user_count})

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 7860))
    doc_count = 0
    if qdrant_client:
        try: doc_count = qdrant_client.get_collection("university_notes").points_count
        except: pass
    print("\n" + "="*60)
    print("🚀 SERVER STARTED")
    print(f"📚 Documents: {doc_count}")
    print(f"👥 Users: {users_collection.count_documents({}) if users_collection else 0}")
    print(f"🧠 Memory: MongoDB + SQLite fallback")
    print(f"📡 Streaming: /chat/stream")
    print(f"🃏 Flashcards: /generate-flashcards")
    print(f"📝 Summaries: /generate-summary")
    print(f"🔍 Web Search: DuckDuckGo + Wikipedia + AnySearch")
    print(f"🌐 http://0.0.0.0:{port}/")
    print("="*60 + "\n")
    app.run(host='0.0.0.0', port=port, debug=False, threaded=True)