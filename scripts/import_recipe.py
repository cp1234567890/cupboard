
import json
import os
from pathlib import Path
from urllib.parse import urlparse

from recipe_scrapers import scrape_me


def main():
    url = os.environ["RECIPE_URL"].strip()

    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise ValueError("Invalid recipe URL")

    scraper = scrape_me(url)

    recipe = {
        "name": scraper.title(),
        "ingredients": scraper.ingredients(),
        "method": scraper.instructions_list(),
        "source": url,
    }

    try:
        recipe["servings"] = scraper.yields()
    except Exception:
        recipe["servings"] = ""

    try:
        recipe["total_time"] = scraper.total_time()
    except Exception:
        recipe["total_time"] = None

    output = Path("recipe-import.json")
    output.write_text(
        json.dumps(recipe, indent=2, ensure_ascii=False),
        encoding="utf-8"
    )

    print(f"Successfully extracted: {recipe['name']}")
    print(f"Ingredients: {len(recipe['ingredients'])}")


if __name__ == "__main__":
    main()
