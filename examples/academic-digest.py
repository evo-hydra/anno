"""Academic digest demo using NeuroSurf's semantic API.
1. Index sample research snippets.
2. Run RAG query for a quick digest.
Requires the NeuroSurf server running locally.
"""

import json
import urllib.request

API_BASE = "http://localhost:5213"

DOCUMENTS = {
    "documents": [
        {
            "id": "paper-llm",
            "text": "This paper explores retrieval augmented language models for domain adaptation.",
            "metadata": {"url": "https://papers.example.com/rag"},
        },
        {
            "id": "paper-eval",
            "text": "We propose evaluation metrics for agent coordination in multi-step tasks.",
            "metadata": {"url": "https://papers.example.com/eval"},
        },
    ]
}


def post_json(path: str, payload: dict) -> dict:
    req = urllib.request.Request(
        f"{API_BASE}{path}",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main() -> None:
    print("Indexing academic snippets...")
    post_json("/v1/semantic/index", DOCUMENTS)

    print("Running RAG query...")
    rag = post_json(
        "/v1/semantic/rag",
        {
            "query": "Summarize recent advances in retrieval augmented language models",
            "sessionId": "academic-session",
            "k": 2,
            "summaryLevels": ["paragraph"],
        },
    )

    print("\n=== Academic Digest ===")
    print(rag["answer"])

    print("\nCitations:")
    for cite in rag["citations"]:
        print(f"- {cite['id']} (score={cite['score']:.2f}) {cite.get('url', '')}")


if __name__ == "__main__":
    main()
