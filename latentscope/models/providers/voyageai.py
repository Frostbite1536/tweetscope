import os
import time
import math
import random
from .base import EmbedModelProvider


class VoyageAIEmbedProvider(EmbedModelProvider):
    def load_model(self):
        import voyageai
        from tokenizers import Tokenizer
        from latentscope.util import get_key
        api_key = get_key("VOYAGE_API_KEY")
        if api_key is None:
            raise ValueError(
                f"VOYAGE_API_KEY not found. Set it in {os.getcwd()}/.env or as an environment variable."
            )
        self.client = voyageai.Client(api_key)
        # The voyage client provides a tokenizer that only encodes https://docs.voyageai.com/tokenization/
        # It also says that it uses the same tokenizer as Llama 2
        self.encoder = Tokenizer.from_pretrained("TheBloke/Llama-2-70B-fp16")

    def embed(self, inputs, dimensions=None):
        # We truncate the input ourselves, even though the API supports truncation its still possible to send too big a batch
        enc = self.encoder
        max_tokens = self.params["max_tokens"]
        normalized_inputs = []
        for b in inputs:
            text = b if b is not None else " "
            token_ids = enc.encode(text).ids
            if len(token_ids) > max_tokens:
                text = enc.decode(token_ids[:max_tokens])
            normalized_inputs.append(text)

        max_retries = int(self.params.get("max_retries", 5))
        base_delay = float(self.params.get("retry_base_delay", 0.5))
        truncation = self.params.get("truncation", True)

        attempt = 0
        while True:
            try:
                response = self.client.embed(
                    texts=normalized_inputs,
                    model=self.name,
                    truncation=truncation,
                )
                return response.embeddings
            except Exception as e:
                attempt += 1
                err = str(e).lower()
                retryable = (
                    "429" in err
                    or "rate limit" in err
                    or "timeout" in err
                    or "temporar" in err
                    or "5xx" in err
                )
                if (not retryable) or attempt > max_retries:
                    raise
                sleep_s = base_delay * (2 ** (attempt - 1)) + random.uniform(0, 0.25)
                time.sleep(sleep_s)


class VoyageContextEmbedProvider(EmbedModelProvider):
    """Voyage contextualized embeddings — groups related chunks (thread tweets)
    so each chunk's vector captures sibling context."""

    def load_model(self):
        import voyageai
        from tokenizers import Tokenizer
        from latentscope.util import get_key
        api_key = get_key("VOYAGE_API_KEY")
        if api_key is None:
            raise ValueError(
                f"VOYAGE_API_KEY not found. Set it in {os.getcwd()}/.env or as an environment variable."
            )
        self.client = voyageai.Client(api_key)
        self.encoder = Tokenizer.from_pretrained("TheBloke/Llama-2-70B-fp16")

    def count_tokens(self, text):
        """Count tokens for a single text string."""
        if text is None or text == "":
            return 1
        return len(self.encoder.encode(text).ids)

    def embed_contextual(self, groups, dimensions=None):
        """Embed grouped chunks with cross-chunk context awareness.

        Args:
            groups: List[List[str]] — each inner list is ordered chunks
                    (e.g. tweets in a thread) sharing context.
            dimensions: optional output dimension (256/512/1024/2048)

        Returns:
            List[List[List[float]]] — result[i][j] = embedding vector for
            chunk j of group i.
        """
        max_retries = int(self.params.get("max_retries", 5))
        base_delay = float(self.params.get("retry_base_delay", 0.5))
        output_dim = dimensions or self.params.get("default_output_dimension")

        attempt = 0
        while True:
            try:
                response = self.client.contextualized_embed(
                    inputs=groups,
                    model=self.name,
                    input_type="document",
                    output_dimension=output_dim,
                )
                # response.results[i].embeddings is List[List[float]]
                # Sort by index to match input order
                sorted_results = sorted(response.results, key=lambda r: r.index)
                return [r.embeddings for r in sorted_results]
            except Exception as e:
                attempt += 1
                err = str(e).lower()
                retryable = (
                    "429" in err
                    or "rate limit" in err
                    or "timeout" in err
                    or "temporar" in err
                    or "5xx" in err
                )
                # On 400 limit-exceeded, split in half and retry
                if "400" in err and len(groups) > 1:
                    mid = len(groups) // 2
                    left = self.embed_contextual(groups[:mid], dimensions)
                    right = self.embed_contextual(groups[mid:], dimensions)
                    return left + right
                if (not retryable) or attempt > max_retries:
                    raise
                sleep_s = base_delay * (2 ** (attempt - 1)) + random.uniform(0, 0.25)
                time.sleep(sleep_s)

    def embed(self, inputs, dimensions=None):
        """Fallback: wrap each input as a single-element group."""
        groups = [[text] for text in inputs]
        results = self.embed_contextual(groups, dimensions)
        return [embs[0] for embs in results]
