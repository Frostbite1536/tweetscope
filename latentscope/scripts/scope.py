import argparse

from latentscope.pipeline.scope_runner import run_scope


def main() -> None:
    parser = argparse.ArgumentParser(description="Setup a scope")
    parser.add_argument("dataset_id", type=str, help="Dataset id (directory name in data folder)")
    parser.add_argument("embedding_id", type=str, help="Embedding id")
    parser.add_argument("umap_id", type=str, help="UMAP id")
    parser.add_argument("cluster_labels_id", type=str, help="Cluster labels id")
    parser.add_argument("label", type=str, help="Label for the scope")
    parser.add_argument("description", type=str, help="Description of the scope")
    parser.add_argument(
        "--cluster-id",
        "--cluster_id",
        dest="cluster_id",
        type=str,
        default=None,
        help="Optional flat cluster id. Omit for hierarchy-backed scopes.",
    )
    parser.add_argument(
        "--scope_id", type=str, help="Scope id to overwrite existing scope", default=None
    )

    args = parser.parse_args()
    scope(**vars(args))


def scope(
    dataset_id,
    embedding_id,
    umap_id,
    cluster_id,
    cluster_labels_id,
    label,
    description,
    scope_id=None,
):
    """
    Backwards-compatible entrypoint used by `ls-scope` and `twitter_import.py`.
    Delegates to the decomposed pipeline orchestrator.
    """
    return run_scope(
        dataset_id=dataset_id,
        embedding_id=embedding_id,
        umap_id=umap_id,
        cluster_id=cluster_id,
        cluster_labels_id=cluster_labels_id,
        label=label,
        description=description,
        scope_id=scope_id,
    )


if __name__ == "__main__":
    main()
