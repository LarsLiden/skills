"""
Example skill entrypoint.

Replace this with the actual skill implementation.
"""

import argparse


def run(input_text: str, verbose: bool = False) -> str:
    if verbose:
        print(f"Processing: {input_text!r}")
    return input_text


def main():
    parser = argparse.ArgumentParser(description="Example skill")
    parser.add_argument("--input_text", required=True, help="The text to process.")
    parser.add_argument("--verbose", action="store_true", help="Enable verbose output.")
    args = parser.parse_args()

    result = run(args.input_text, args.verbose)
    print(result)


if __name__ == "__main__":
    main()
