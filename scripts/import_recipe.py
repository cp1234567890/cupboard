"""Cupboard recipe importer. Preserves the existing flat output, adding optional sections."""
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
        return BeautifulSoup(value, "html.parser").get_text(" ", strip=True)
    return str(value or "").strip()


def extract_steps(value):
    if isinstance(value, str):
        soup = BeautifulSoup(value, "html.parser")
        return [line.strip() for line in soup.get_text("\n").splitlines() if line.strip()]
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
    if isinstance(data, list):
        for item in data:
            yield from find_recipes(item)
    elif isinstance(data, dict):
        types = data.get("@type", [])
        if isinstance(types, str):
            types = [types]
        if any(str(t).split("/")[-1].lower() == "recipe" for t in types):
            yield data
        for value in data.values():
            if isinstance(value, (dict, list)):
                yield from find_recipes(value)


def named_method_sections(value):
    """Read explicitly named schema.org HowToSection instructions, when supplied."""
    if not isinstance(value, list):
        value = [value]
    result = []
    for item in value:
        if not isinstance(item, dict):
            return []
        types = item.get("@type", [])
        if isinstance(types, str):
            types = [types]
        if not any(str(t).split("/")[-1].lower() == "howtosection" for t in types):
            return []
        name = clean_text(item.get("name"))
        steps = extract_steps(item.get("itemListElement", []))
        if not name or not steps:
            return []
        result.append({"name": name, "ingredients": [], "method": steps})
    return result if len(result) > 1 else []


def ingredient_sections(lines):
    """Detect clear ingredient headings only; never guess a section from ingredient names."""
    groups = []
    current = None
    heading = re.compile(r"^(?:for\s+)?(?:the\s+)?(.{3,65}):\s*$", re.I)
    for line in lines:
        match = heading.match(line.strip())
        if match and not re.match(r"^\d", line):
            current = {"name": match.group(1).strip(), "ingredients": [], "method": []}
            groups.append(current)
        elif current:
            current["ingredients"].append(line)
        else:
            # Without a first heading the division is ambiguous.
            return []
    if len(groups) < 2 or any(not g["ingredients"] for g in groups):
        return []
    return groups


def detect_sections(ingredients, instructions):
    groups = ingredient_sections(ingredients)
    methods = named_method_sections(instructions)
    if groups and methods and len(groups) == len(methods):
        # Only align when section names clearly correspond.
        def key(s):
            return re.sub(r"[^a-z0-9]", "", s.lower())
        if all(key(a["name"]) == key(b["name"]) for a, b in zip(groups, methods)):
            for group, method in zip(groups, methods):
                group["method"] = method["method"]
            return groups
    # Named method sections without ingredient groupings cannot safely allocate ingredients.
    # Keep the recipe flat so the user can divide it in the import preview.
    return []


def duration_minutes(value):
    if not value:
        return None
    match = re.fullmatch(r"P(?:\d+D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", str(value), re.I)
    if not match:
        return None
    hours, minutes, seconds = (int(x or 0) for x in match.groups())
    return hours * 60 + minutes + (seconds + 59) // 60


def structured_fallback(url):
    print("Trying structured recipe data fallback...", flush=True)
    response = requests.get(
        url,
        headers={"User-Agent": "Mozilla/5.0 (compatible; CupboardRecipeImporter/1.0)",
                 "Accept": "text/html,application/xhtml+xml"},
        timeout=30,
    )
    response.raise_for_status()
    soup = BeautifulSoup(response.text, "html.parser")
    for script in soup.find_all("script", type="application/ld+json"):
        try:
            data = json.loads(script.string or script.get_text())
        except (ValueError, TypeError):
            continue
        for item in find_recipes(data):
            name = clean_text(item.get("name"))
            raw_ingredients = item.get("recipeIngredient", [])
            if isinstance(raw_ingredients, str):
                raw_ingredients = [raw_ingredients]
            ingredients = [clean_text(i) for i in raw_ingredients if clean_text(i)]
            instructions = item.get("recipeInstructions", [])
            method = extract_steps(instructions)
            if not name or not ingredients or not method:
                continue
            servings = item.get("recipeYield", "")
            if isinstance(servings, list):
                servings = ", ".join(map(str, servings))
            result = {"name": name, "ingredients": ingredients, "method": method,
                      "source": url, "servings": servings,
                      "total_time": duration_minutes(item.get("totalTime"))}
            sections = detect_sections(ingredients, instructions)
            if sections:
                result["sections"] = sections
            return result
    raise RuntimeError("No complete Recipe JSON-LD found on this page. The website may use a JavaScript-only recipe interface or a different structured-data format.")


def main():
    url = os.environ["RECIPE_URL"].strip()
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise ValueError("Invalid recipe URL")
    recipe = None
    try:
        scraper = scrape_me(url)
        recipe = {"name": scraper.title(), "ingredients": scraper.ingredients(),
                  "method": scraper.instructions_list(), "source": url}
        try:
            recipe["servings"] = scraper.yields()
        except Exception:
            recipe["servings"] = ""
        try:
            recipe["total_time"] = scraper.total_time()
        except Exception:
            recipe["total_time"] = None
        if not recipe["name"] or not recipe["ingredients"] or not recipe["method"]:
            print("Primary scraper returned incomplete data.", flush=True)
            recipe = None
        else:
            # Scraper output is generally flattened. Only section ingredient headings
            # are inferred here; ambiguous recipes stay flat for manual review.
            # Scraper output lacks reliable named method/ingredient pairing.
            # Preserve the flat result and let the preview divide it safely.
            pass
    except Exception as exc:
        print(f"Primary scraper failed: {type(exc).__name__}: {exc}", flush=True)
    if recipe is None:
        recipe = structured_fallback(url)
    Path("recipe-import.json").write_text(json.dumps(recipe, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Successfully extracted: {recipe['name']}")
    print(f"Ingredients: {len(recipe['ingredients'])}")
    print(f"Method steps: {len(recipe['method'])}")
    print(f"Sections: {len(recipe.get('sections', []))}")


if __name__ == "__main__":
    main()
