
import json
import os
import re
from pathlib import Path
from urllib.parse import urlparse

import requests
from bs4 import BeautifulSoup
from recipe_scrapers import scrape_me


def clean_text(value):
    if isinstance(value, str):
        return BeautifulSoup(value, "html.parser").get_text(
            " ", strip=True
        )
    return str(value or "").strip()


def extract_steps(value):
    """Convert structured recipe instructions into a list of steps."""
    if isinstance(value, str):
        soup = BeautifulSoup(value, "html.parser")
        lines = [
            line.strip()
            for line in soup.get_text("\n").splitlines()
            if line.strip()
        ]
        return lines

    if isinstance(value, dict):
        if value.get("text"):
            return extract_steps(value["text"])

        steps = []
        for item in value.get("itemListElement", []):
            steps.extend(extract_steps(item))
        return steps

    if isinstance(value, list):
        steps = []
        for item in value:
            steps.extend(extract_steps(item))
        return steps

    return []


def find_recipes(data):
    """Recursively locate schema.org Recipe objects."""
    if isinstance(data, list):
        for item in data:
            yield from find_recipes(item)

    elif isinstance(data, dict):
        types = data.get("@type", [])
        if isinstance(types, str):
            types = [types]

        if any(
            str(t).split("/")[-1].lower() == "recipe"
            for t in types
        ):
            yield data

        for key, value in data.items():
            if isinstance(value, (dict, list)):
                yield from find_recipes(value)


def structured_fallback(url):
    print("Trying structured recipe data fallback...", flush=True)

    response = requests.get(
        url,
        headers={
            "User-Agent": (
                "Mozilla/5.0 (compatible; CupboardRecipeImporter/1.0)"
            ),
            "Accept": "text/html,application/xhtml+xml",
        },
        timeout=30,
    )
    response.raise_for_status()

    soup = BeautifulSoup(response.text, "html.parser")

    for script in soup.find_all(
        "script", type="application/ld+json"
    ):
        try:
            data = json.loads(script.string or script.get_text())
        except (ValueError, TypeError):
            continue

        for item in find_recipes(data):
            name = clean_text(item.get("name"))

            ingredients = item.get("recipeIngredient", [])
            if isinstance(ingredients, str):
                ingredients = [ingredients]

            ingredients = [
                clean_text(ingredient)
                for ingredient in ingredients
                if clean_text(ingredient)
            ]

            method = extract_steps(
                item.get("recipeInstructions", [])
            )

            if not name or not ingredients or not method:
                continue

            total_time = item.get("totalTime")
            if total_time:
                match = re.fullmatch(
                    r"P(?:\d+D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?",
                    str(total_time),
                    re.I,
                )
                if match:
                    hours, minutes, seconds = (
                        int(x or 0) for x in match.groups()
                    )
                    total_time = (
                        hours * 60 + minutes + (seconds + 59) // 60
                    )
                else:
                    total_time = None

            servings = item.get("recipeYield", "")
            if isinstance(servings, list):
                servings = ", ".join(map(str, servings))

            return {
                "name": name,
                "ingredients": ingredients,
                "method": method,
                "source": url,
                "servings": servings,
                "total_time": total_time,
            }

    raise RuntimeError(
        "No complete Recipe JSON-LD found on this page. "
        "The website may use a JavaScript-only recipe interface "
        "or a different structured-data format."
    )


def main():
    url = os.environ["RECIPE_URL"].strip()

    parsed = urlparse(url)

    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise ValueError("Invalid recipe URL")

    recipe = None

    try:
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

        if (
            not recipe["name"]
            or not recipe["ingredients"]
            or not recipe["method"]
        ):
            print(
                "Primary scraper returned incomplete data.",
                flush=True,
            )
            recipe = None

    except Exception as exc:
        print(
            f"Primary scraper failed: {type(exc).__name__}: {exc}",
            flush=True,
        )

    if recipe is None:
        recipe = structured_fallback(url)

    output = Path("recipe-import.json")

    output.write_text(
        json.dumps(recipe, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )

    print(f"Successfully extracted: {recipe['name']}")
    print(f"Ingredients: {len(recipe['ingredients'])}")
    print(f"Method steps: {len(recipe['method'])}")


if __name__ == "__main__":
    main()
