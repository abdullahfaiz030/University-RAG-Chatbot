import os
import requests
import re
import uuid
import time
from urllib.parse import urljoin, urlparse, unquote
from bs4 import BeautifulSoup
from qdrant_client.http import models as qdrant_models
from qdrant_client import QdrantClient

# Import text cleaning helpers if available, or define fallback
try:
    from app import clean_text, chunk_text
except ImportError:
    def clean_text(text):
        text = re.sub(r'\s+', ' ', text)
        return text.strip()

    def chunk_text(text, size=500, overlap=50):
        # Fallback simple word-based chunker
        words = text.split()
        chunks = []
        for i in range(0, len(words), size - overlap):
            chunk = " ".join(words[i:i + size])
            if len(chunk.strip()) > 50:
                chunks.append(chunk)
        return chunks

# Predefined key pages to ensure we prioritize faculties and contact info
STARTING_PAGES = [
    "https://www.seu.ac.lk/",
    "http://www.seu.ac.lk/overview.php",
    "http://www.seu.ac.lk/contactus.php",
    "http://www.seu.ac.lk/academic_staff.php",
    "http://www.seu.ac.lk/fas/index.php",
    "http://www.seu.ac.lk/fas/staffNew.html",
    "http://www.seu.ac.lk/fac/index.php",
    "http://www.seu.ac.lk/fia/index.php",
    "http://www.seu.ac.lk/fmc/index.php",
    "http://fe.seu.ac.lk/index.php",
    "http://www.seu.ac.lk/ft/index.php"
]

def crawl_and_extract(max_pages=40):
    visited = set()
    starting_queue = list(STARTING_PAGES)
    priority_queue = []
    regular_queue = []
    documents = []

    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    }

    print(f"🚀 Starting crawl of South Eastern University website (limit: {max_pages} pages)")

    while (starting_queue or priority_queue or regular_queue) and len(visited) < max_pages:
        # Multi-level queue logic: starting_pages -> staff/priority -> regular
        if starting_queue:
            url = starting_queue.pop(0)
        elif priority_queue:
            url = priority_queue.pop(0)
        else:
            url = regular_queue.pop(0)

        if url in visited:
            continue

        # Basic URL filtering
        parsed_url = urlparse(url)
        if "seu.ac.lk" not in parsed_url.netloc:
            continue

        # Skip non-HTML files
        if any(url.lower().endswith(ext) for ext in ['.pdf', '.zip', '.png', '.jpg', '.jpeg', '.docx', '.xlsx', '.csv', '.ppt', '.pptx']):
            continue

        try:
            print(f"Crawling ({len(visited)+1}/{max_pages}): {url}")
            r = requests.get(url, headers=headers, timeout=10)
            visited.add(url)

            if r.status_code == 200:
                soup = BeautifulSoup(r.text, 'html.parser')

                # Extract title
                title = soup.title.string.strip() if soup.title else "SEUSL Page"
                title = re.sub(r'\s+', ' ', title)

                # Strip script, style, nav, and footer
                for element in soup(["script", "style", "nav", "footer", "header"]):
                    element.decompose()

                # Get text
                text = soup.get_text(separator="\n")
                lines = [line.strip() for line in text.splitlines()]
                cleaned_lines = []
                for line in lines:
                    # Skip menu options or common boilerplates
                    if len(line) < 5 or line.lower() in ['home', 'about', 'contact', 'search', 'menu', 'navigation']:
                        continue
                    cleaned_lines.append(line)
                
                full_text = "\n".join(cleaned_lines)
                full_text = clean_text(full_text)

                if len(full_text) > 100:
                    documents.append({
                        "url": url,
                        "title": title,
                        "text": full_text
                    })

                # Find links
                for link in soup.find_all('a', href=True):
                    href = link['href']
                    full_href = urljoin(url, href)
                    # Normalize and strip fragment
                    full_href = full_href.split('#')[0].rstrip('/')
                    
                    if "seu.ac.lk" in urlparse(full_href).netloc:
                        # Check if the link should be skipped (e.g. notices, news, downloads)
                        skip_keywords = ['/notice', '/news', '/events', '/gallery', '/download', 'download.php', 'faq.php', 'agrahara.php', 'bylaws.php', 'sitemap.php', 'gallery/']
                        is_valid = not any(kw in full_href.lower() for kw in skip_keywords)
                        
                        if is_valid and full_href not in visited and full_href not in starting_queue and full_href not in priority_queue and full_href not in regular_queue:
                            # Prioritize staff, profiles, divisions, and departments
                            is_priority = any(k in unquote(full_href).lower() for k in ['staff', 'profile', 'division of', 'department of', 'depatment of', 'deanoffice', 'pg_unit'])
                            if is_priority:
                                priority_queue.append(full_href)
                            else:
                                regular_queue.append(full_href)

            # Polite delay
            time.sleep(0.5)

        except Exception as e:
            print(f"Error crawling {url}: {e}")
            visited.add(url)

    return documents

def sync_university_website(qdrant_client, embedding_model, max_pages=40):
    if not qdrant_client or not embedding_model:
        print("❌ Qdrant client or embedding model not initialized. Skipping sync.")
        return False

    try:
        # 1. Fetch live documents
        docs = crawl_and_extract(max_pages)
        if not docs:
            print("⚠️ No documents scraped from university website.")
            return False

        print(f"✅ Scraped {len(docs)} pages successfully. Preparing to index...")

        # 2. Delete old crawler points to avoid duplicates
        try:
            qdrant_client.delete(
                collection_name="university_notes",
                points_selector=qdrant_models.Filter(
                    must=[
                        qdrant_models.FieldCondition(
                            key="source",
                            match=qdrant_models.MatchValue(value="website_crawler")
                        )
                    ]
                )
            )
            print("🧹 Removed previous university website crawler points from Qdrant.")
        except Exception as e:
            print(f"⚠️ Error cleaning old crawler points: {e}")

        # 3. Create fresh embeddings and upsert
        points = []
        import pandas as pd
        for doc in docs:
            chunks = chunk_text(doc["text"])
            for i, chunk in enumerate(chunks):
                # We prepend title and URL to the text chunk to provide rich context to the LLM
                rich_text = f"Source: {doc['title']} (URL: {doc['url']})\n\n{chunk}"
                embedding = embedding_model.encode(rich_text).tolist()
                
                point_id = str(uuid.uuid4())
                points.append(qdrant_models.PointStruct(
                    id=point_id,
                    vector=embedding,
                    payload={
                        "filename": f"Website: {doc['title']}",
                        "text": rich_text,
                        "chunk_index": i,
                        "source": "website_crawler",
                        "url": doc["url"],
                        "upload_date": str(pd.Timestamp.now())
                    }
                ))

        if points:
            qdrant_client.upsert(collection_name="university_notes", points=points)
            print(f"🎉 Successfully indexed {len(points)} website chunks into Qdrant collection 'university_notes'!")
            return True
        else:
            print("⚠️ No points generated to upsert.")
            return False

    except Exception as e:
        print(f"❌ Error during university website sync: {e}")
        return False
