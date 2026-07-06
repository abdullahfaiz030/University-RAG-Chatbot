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
from datetime import timedelta, datetime
import traceback
import time
import re
import uuid
import requests
import sqlite3
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

# ========== PERSISTENT CONVERSATION MEMORY (SQLite) ==========
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


def save_message(session_id, role, content):
    conn = get_db_connection()
    try:
        conn.execute(
            'INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)',
            (session_id, role, content, datetime.utcnow().isoformat())
        )
        conn.commit()
    finally:
        conn.close()


def get_session_history(session_id, limit=MAX_HISTORY):
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


def trim_session_history(session_id, keep=MAX_HISTORY):
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


def clear_session_history(session_id):
    conn = get_db_connection()
    try:
        conn.execute('DELETE FROM messages WHERE session_id = ?', (session_id,))
        conn.commit()
    finally:
        conn.close()


init_db()

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
groq_connected = bool(groq_api_key)
if groq_connected:
    print("✅ Groq API key found")
else:
    print("❌ Groq API key missing")

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


GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
MODELS_TO_TRY = ["llama-3.1-8b-instant", "llama-3.3-70b-versatile", "mixtral-8x7b-32768"]


def groq_chat_completion(messages, model="llama-3.1-8b-instant", max_tokens=150, temperature=0.7):
    headers = {"Authorization": f"Bearer {groq_api_key}", "Content-Type": "application/json"}
    payload = {"model": model, "messages": messages, "max_tokens": max_tokens, "temperature": temperature}
    response = requests.post(GROQ_URL, json=payload, headers=headers, timeout=30)
    if response.status_code == 200:
        return response.json()["choices"][0]["message"]["content"]
    raise Exception(f"Groq API error: {response.status_code}")


def groq_chat_completion_stream(messages, model="llama-3.1-8b-instant", max_tokens=150, temperature=0.7):
    headers = {"Authorization": f"Bearer {groq_api_key}", "Content-Type": "application/json"}
    payload = {
        "model": model, "messages": messages, "max_tokens": max_tokens,
        "temperature": temperature, "stream": True
    }
    with requests.post(GROQ_URL, json=payload, headers=headers, timeout=30, stream=True) as response:
        if response.status_code != 200:
            raise Exception(f"Groq API error: {response.status_code}")
        for raw_line in response.iter_lines():
            if not raw_line:
                continue
            line = raw_line.decode('utf-8')
            if not line.startswith('data: '):
                continue
            payload_str = line[len('data: '):].strip()
            if payload_str == '[DONE]':
                break
            try:
                chunk = json.loads(payload_str)
                delta = chunk.get('choices', [{}])[0].get('delta', {}).get('content', '')
                if delta:
                    yield delta
            except (json.JSONDecodeError, IndexError, KeyError):
                continue


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


# ========== SHARED PROMPT-BUILDING LOGIC ==========

def build_chat_context(user_message, session_id):
    user_lower = user_message.lower().strip()
    sentiment = analyze_sentiment(user_message)

    # ---- Follow-up detection ----
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

    # ---- Pull history from SQLite ----
    history = get_session_history(session_id)
    recent_history = ""
    previous_topic = ""
    history_messages = []  # For including as real message context

    if history:
        last_messages = history[-6:]
        for msg in last_messages:
            role = "User" if msg['role'] == 'user' else "Assistant"
            recent_history += f"{role}: {msg['content']}\n"

        last_user_msgs = [m['content'] for m in history if m['role'] == 'user']
        if last_user_msgs:
            previous_topic = last_user_msgs[-1]

        # For follow-ups, get the last 4 messages to send as real context
        if is_follow_up:
            history_messages = history[-4:]

    # ---- Classification ----
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

    # ---- Web search ----
    web_results = None
    if needs_realtime and not is_casual:
        web_results = search_web(user_message)

    # ---- Document search ----
    doc_context = ""
    if qdrant_client and embedding_model and not is_casual and not web_results:
        if is_follow_up and previous_topic:
            search_query = previous_topic
        else:
            search_query = user_message
        try:
            query_embedding = embedding_model.encode(search_query).tolist()
            search_results = qdrant_client.search(
                collection_name="university_notes", query_vector=query_embedding, limit=3
            )
            if search_results:
                texts = [hit.payload.get('text', '') for hit in search_results]
                if texts:
                    doc_context = "\n\n".join(texts[:3])
        except Exception as e:
            print(f"Search error: {e}")

    # ---- Build prompts ----
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
        system_prompt = f"You are a helpful AI tutor. The user is asking a FOLLOW-UP question about: '{previous_topic}'. Use the conversation history and reference material to EXPAND on the topic. Give more details. Answer in 3-5 sentences. NEVER mention notes or documents."
        user_prompt = f"Reference material about '{previous_topic}':\n{doc_context[:500]}\n\nUser says: {user_message}\n\nExpand on '{previous_topic}' with more detail:"
        max_tokens = 200
    elif is_follow_up and not doc_context:
        system_prompt = f"You are a helpful AI tutor. The user is asking a FOLLOW-UP question about: '{previous_topic}'. Use the conversation history and your knowledge to EXPAND on the topic. Give more details. Answer in 3-5 sentences."
        user_prompt = f"Previous topic: '{previous_topic}'. User says: {user_message}\n\nExpand on '{previous_topic}':"
        max_tokens = 200
    elif doc_context:
        system_prompt = "You are a helpful AI tutor. Answer in 1-3 SHORT sentences. Be direct. NEVER mention notes or documents."
        user_prompt = f"Reference (read silently):\n{doc_context[:500]}\n\nQuestion: {user_message}\n\nShort answer:"
        max_tokens = 100
    else:
        system_prompt = "You are a smart AI assistant. Answer in 1-3 SHORT sentences. Be direct. NO paragraphs."
        user_prompt = f"Question: {user_message}\n\nShort answer:"
        max_tokens = 100

    mode = 'followup' if is_follow_up else ('realtime' if web_results else ('study' if doc_context else 'general'))

    return {
        'system_prompt': system_prompt,
        'user_prompt': user_prompt,
        'max_tokens': max_tokens,
        'mode': mode,
        'sentiment': sentiment,
        'is_greeting': is_greeting,
        'is_thanks': is_thanks,
        'is_follow_up': is_follow_up,
        'history_messages': history_messages,
    }


def postprocess_response(text, ctx):
    if not text:
        return "How can I help you today?"
    text = re.sub(r'\*{1,3}', '', text)
    text = re.sub(r'#{1,4}\s*', '', text)
    text = text.strip()
    if ctx['is_greeting'] and (len(text) < 2 or len(text) > 60):
        text = "Hey there! 👋 How can I help you today?"
    if ctx['is_thanks'] and len(text) > 30:
        text = "You're welcome! 😊"
    if not text or len(text) < 2:
        text = "How can I help you today?"
    return text


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
    """Non-streaming endpoint with conversation history context."""
    try:
        data = request.json
        user_message = data.get('message', '').strip()
        session_id = data.get('session_id', 'default')

        if not user_message:
            return jsonify({'response': 'Please type a message.'}), 400
        if not groq_api_key:
            return jsonify({'response': 'AI service not available.'}), 500

        ctx = build_chat_context(user_message, session_id)

        # Build messages with conversation history for follow-ups
        messages = [{"role": "system", "content": ctx['system_prompt']}]
        if ctx.get('is_follow_up') and ctx.get('history_messages'):
            messages.extend(ctx['history_messages'])
        messages.append({"role": "user", "content": ctx['user_prompt']})

        response_text = None
        for model in MODELS_TO_TRY:
            try:
                response_text = groq_chat_completion(
                    messages=messages,
                    model=model, max_tokens=ctx['max_tokens'], temperature=0.7
                )
                break
            except Exception:
                continue

        if response_text:
            response_text = postprocess_response(response_text, ctx)

            save_message(session_id, 'user', user_message)
            save_message(session_id, 'assistant', response_text)
            trim_session_history(session_id)

            suggestions = generate_suggestions(user_message, response_text)

            return jsonify({
                'response': response_text,
                'sources': [],
                'mode': ctx['mode'],
                'sentiment': ctx['sentiment'],
                'suggestions': suggestions
            })
        else:
            return jsonify({'response': "I'm having trouble right now. Could you try asking again?"}), 500

    except Exception as e:
        print(f"Chat error: {e}")
        return jsonify({'response': "Sorry, I encountered an issue. Please try again!"}), 500


@app.route('/chat/stream', methods=['POST'])
def chat_stream():
    """Streaming endpoint with conversation history context."""
    data = request.json or {}
    user_message = (data.get('message') or '').strip()
    session_id = data.get('session_id', 'default')

    if not user_message:
        return jsonify({'error': 'Please type a message.'}), 400
    if not groq_api_key:
        return jsonify({'error': 'AI service not available.'}), 500

    ctx = build_chat_context(user_message, session_id)

    def event_stream():
        full_response = ""
        # Build messages with conversation history for follow-ups
        messages = [{"role": "system", "content": ctx['system_prompt']}]
        if ctx.get('is_follow_up') and ctx.get('history_messages'):
            messages.extend(ctx['history_messages'])
        messages.append({"role": "user", "content": ctx['user_prompt']})

        streamed_ok = False

        for model in MODELS_TO_TRY:
            try:
                for delta in groq_chat_completion_stream(messages, model=model, max_tokens=ctx['max_tokens'], temperature=0.7):
                    full_response += delta
                    yield f"data: {json.dumps({'delta': delta})}\n\n"
                streamed_ok = True
                break
            except Exception as e:
                full_response = ""
                continue

        if not streamed_ok:
            yield f"data: {json.dumps({'error': 'AI service is having trouble. Please try again.'})}\n\n"
            return

        clean_response = postprocess_response(full_response, ctx)

        save_message(session_id, 'user', user_message)
        save_message(session_id, 'assistant', clean_response)
        trim_session_history(session_id)

        suggestions = generate_suggestions(user_message, clean_response)

        yield f"data: {json.dumps({'done': True, 'mode': ctx['mode'], 'sentiment': ctx['sentiment'], 'suggestions': suggestions})}\n\n"

    return Response(
        event_stream(),
        mimetype='text/event-stream',
        headers={
            'Cache-Control': 'no-cache',
            'X-Accel-Buffering': 'no',
            'Connection': 'keep-alive',
        }
    )


@app.route('/clear-history', methods=['POST'])
def clear_history():
    data = request.json or {}
    session_id = data.get('session_id', 'default')
    clear_session_history(session_id)
    return jsonify({'success': True})


@app.route('/export-chat', methods=['POST'])
def export_chat():
    try:
        data = request.json
        session_id = data.get('session_id', 'default')
        format_type = data.get('format', 'txt')

        messages = get_session_history(session_id, limit=10_000)
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
        'api_connected': groq_connected,
        'qdrant_connected': qdrant_client is not None,
        'web_search': 'DuckDuckGo + Wikipedia + AnySearch (All Free)',
        'features': ['persistent_memory', 'streaming', 'follow_up_context', 'sentiment', 'suggestions', 'export', 'multi_language']
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
    print(f"🧠 Memory: SQLite-backed ({DB_PATH}), {MAX_HISTORY} messages/session")
    print(f"📡 Streaming: Enabled at /chat/stream (SSE)")
    print(f"💬 Follow-up Detection: Enabled (with message context)")
    print(f"😊 Sentiment Analysis: Enabled")
    print(f"💡 Smart Suggestions: Enabled")
    print(f"📤 Chat Export: Enabled")
    print(f"🔍 Web Search: DuckDuckGo + Wikipedia + AnySearch (All Free)")
    print(f"🌐 http://0.0.0.0:{port}/")
    print("="*60 + "\n")
    app.run(host='0.0.0.0', port=port, debug=False, threaded=True)