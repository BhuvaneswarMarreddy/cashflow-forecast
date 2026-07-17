#!/usr/bin/env python3
"""
CashFlow Forecast Logo Generator - Simple & Elegant
Earning Dollars ($) → Saving/Investing in Rupees (₹)
Theme: Deep blue with gold currency symbols
"""

from PIL import Image, ImageDraw, ImageFont
import os
import math

# Color palette
DEEP_BLUE = (30, 64, 175)      # #1e40af
MEDIUM_BLUE = (59, 130, 246)   # #3b82f6
LIGHT_BLUE = (96, 165, 250)    # #60a5fa
DARK_BG = (15, 23, 42)         # Dark blue background #0f172a
GOLD = (255, 215, 0)           # #ffd700
BRIGHT_GOLD = (255, 223, 0)    # Brighter gold
WHITE = (255, 255, 255)
TRANSPARENT = (0, 0, 0, 0)

def draw_rupee_symbol(draw, center_x, center_y, size, color, thickness=None):
    """
    Draw proper Indian Rupee (₹) symbol
    The symbol consists of:
    - Two horizontal lines at top
    - A vertical stroke
    - A diagonal stroke
    """
    if thickness is None:
        thickness = max(2, int(size * 0.12))
    
    half = size / 2
    
    # Top horizontal line
    draw.line([
        (center_x - half * 0.6, center_y - half * 0.7),
        (center_x + half * 0.6, center_y - half * 0.7)
    ], fill=color, width=thickness)
    
    # Second horizontal line (slightly below)
    draw.line([
        (center_x - half * 0.6, center_y - half * 0.3),
        (center_x + half * 0.6, center_y - half * 0.3)
    ], fill=color, width=thickness)
    
    # Vertical stroke on left side
    draw.line([
        (center_x - half * 0.2, center_y - half * 0.7),
        (center_x - half * 0.2, center_y + half * 0.1)
    ], fill=color, width=thickness)
    
    # Diagonal stroke (from middle to bottom right)
    draw.line([
        (center_x - half * 0.2, center_y - half * 0.1),
        (center_x + half * 0.5, center_y + half * 0.8)
    ], fill=color, width=thickness)

def draw_dollar_symbol(draw, center_x, center_y, size, color, thickness=None):
    """Draw dollar ($) symbol manually for consistency"""
    if thickness is None:
        thickness = max(2, int(size * 0.1))
    
    half = size / 2
    
    # The S curve of dollar sign
    # Top curve
    draw.arc([
        center_x - half * 0.4, center_y - half * 0.7,
        center_x + half * 0.4, center_y - half * 0.1
    ], start=180, end=0, fill=color, width=thickness)
    
    # Bottom curve
    draw.arc([
        center_x - half * 0.4, center_y - half * 0.1,
        center_x + half * 0.4, center_y + half * 0.5
    ], start=0, end=180, fill=color, width=thickness)
    
    # Vertical line through the S
    draw.line([
        (center_x, center_y - half * 0.85),
        (center_x, center_y + half * 0.7)
    ], fill=color, width=thickness)

def create_logo_icon(size, output_path):
    """Create the main logo icon - simple and elegant"""
    width, height = size
    
    # Create image with dark blue background
    img = Image.new('RGBA', size, DARK_BG)
    draw = ImageDraw.Draw(img, 'RGBA')
    
    # Calculate dimensions
    padding = int(min(width, height) * 0.1)
    
    # Chart area
    chart_left = padding + int(width * 0.08)
    chart_bottom = height - padding - int(height * 0.08)
    chart_right = width - padding - int(width * 0.08)
    chart_top = padding + int(height * 0.08)
    
    # Draw simple chart axes (L-shape) - very subtle
    axis_color = (MEDIUM_BLUE[0], MEDIUM_BLUE[1], MEDIUM_BLUE[2], 100)
    axis_thickness = max(2, int(min(width, height) * 0.012))
    
    # Y-axis
    draw.line([(chart_left, chart_bottom), (chart_left, chart_top)], 
             fill=axis_color, width=axis_thickness)
    
    # X-axis
    draw.line([(chart_left, chart_bottom), (chart_right, chart_bottom)], 
             fill=axis_color, width=axis_thickness)
    
    # Define positions for symbols and chart line
    dollar_x = chart_left + int(width * 0.12)
    dollar_y = chart_bottom - int(height * 0.15)
    
    rupee_x = chart_right - int(width * 0.12)
    rupee_y = chart_top + int(height * 0.15)
    
    # Draw simple trend line from dollar to rupee
    line_thickness = max(3, int(min(width, height) * 0.035))
    
    # Simple elegant line: start → dip → rise → slight dip → end
    points = [
        (dollar_x, dollar_y),
        (dollar_x + int(width * 0.15), dollar_y + int(height * 0.05)),  # slight dip
        (dollar_x + int(width * 0.35), dollar_y - int(height * 0.2)),   # rise
        (dollar_x + int(width * 0.50), dollar_y - int(height * 0.15)),  # slight dip
        (rupee_x, rupee_y)  # end at rupee
    ]
    
    # Draw the trend line
    for i in range(len(points) - 1):
        draw.line([points[i], points[i + 1]], fill=LIGHT_BLUE, width=line_thickness)
    
    # Draw small arrow head at the end
    end_x, end_y = points[-1]
    prev_x, prev_y = points[-2]
    angle = math.atan2(end_y - prev_y, end_x - prev_x)
    head_size = int(min(width, height) * 0.06)
    
    head_x1 = end_x + head_size * math.cos(angle - 2.5)
    head_y1 = end_y + head_size * math.sin(angle - 2.5)
    head_x2 = end_x + head_size * math.cos(angle + 2.5)
    head_y2 = end_y + head_size * math.sin(angle + 2.5)
    
    draw.polygon([(end_x, end_y), (head_x1, head_y1), (head_x2, head_y2)], fill=LIGHT_BLUE)
    
    # Draw currency symbols - LARGER and more visible
    symbol_size = int(min(width, height) * 0.30)  # 30% of logo size
    symbol_thickness = max(3, int(symbol_size * 0.14))
    
    # Dollar symbol ($) - at start position
    draw_dollar_symbol(draw, dollar_x, dollar_y, symbol_size, BRIGHT_GOLD, symbol_thickness)
    
    # Rupee symbol (₹) - at end position
    draw_rupee_symbol(draw, rupee_x, rupee_y, symbol_size, BRIGHT_GOLD, symbol_thickness)
    
    # Save
    img.save(output_path, 'PNG', optimize=True)
    print(f"✓ Created: {output_path} ({size[0]}x{size[1]})")

def create_favicon(size, output_path):
    """Create favicon - simplified for small sizes"""
    width, height = size
    
    # Create image with dark blue background
    img = Image.new('RGBA', size, DARK_BG)
    draw = ImageDraw.Draw(img, 'RGBA')
    
    padding = int(min(width, height) * 0.12)
    
    # Simple positions
    start_x = padding + int(width * 0.1)
    start_y = height - padding - int(height * 0.15)
    end_x = width - padding - int(width * 0.1)
    end_y = padding + int(height * 0.15)
    
    # Simple trend line
    line_thickness = max(2, int(min(width, height) * 0.08))
    
    # Draw simple ascending line with a dip
    mid_x = (start_x + end_x) / 2
    mid_y = start_y - (start_y - end_y) * 0.4
    dip_y = mid_y + int(height * 0.1)
    
    draw.line([(start_x, start_y), (mid_x * 0.7, dip_y)], fill=LIGHT_BLUE, width=line_thickness)
    draw.line([(mid_x * 0.7, dip_y), (end_x, end_y)], fill=LIGHT_BLUE, width=line_thickness)
    
    # Arrow head
    angle = math.atan2(end_y - dip_y, end_x - mid_x * 0.7)
    head_size = int(min(width, height) * 0.15)
    
    head_x1 = end_x + head_size * math.cos(angle - 2.5)
    head_y1 = end_y + head_size * math.sin(angle - 2.5)
    head_x2 = end_x + head_size * math.cos(angle + 2.5)
    head_y2 = end_y + head_size * math.sin(angle + 2.5)
    
    draw.polygon([(end_x, end_y), (head_x1, head_y1), (head_x2, head_y2)], fill=LIGHT_BLUE)
    
    # Currency symbols for larger favicons
    if size[0] >= 32:
        symbol_size = int(min(width, height) * 0.25)
        symbol_thickness = max(2, int(symbol_size * 0.15))
        
        draw_dollar_symbol(draw, start_x + int(width * 0.08), start_y - int(height * 0.05), 
                          symbol_size, BRIGHT_GOLD, symbol_thickness)
        draw_rupee_symbol(draw, end_x - int(width * 0.05), end_y + int(height * 0.08), 
                         symbol_size, BRIGHT_GOLD, symbol_thickness)
    
    img.save(output_path, 'PNG', optimize=True)
    print(f"✓ Created: {output_path} ({size[0]}x{size[1]})")

def create_logo_with_text(size, output_path, text="CashFlow"):
    """Create logo with text"""
    width, height = size
    icon_size = min(height, int(width * 0.4))
    
    # Create image with dark background
    img = Image.new('RGBA', size, DARK_BG)
    
    # Draw icon
    icon_img = Image.new('RGBA', (icon_size, icon_size), DARK_BG)
    icon_draw = ImageDraw.Draw(icon_img, 'RGBA')
    
    # Simplified icon for horizontal logo
    padding = int(icon_size * 0.1)
    start_x = padding + int(icon_size * 0.1)
    start_y = icon_size - padding - int(icon_size * 0.15)
    end_x = icon_size - padding - int(icon_size * 0.1)
    end_y = padding + int(icon_size * 0.15)
    
    line_thickness = max(2, int(icon_size * 0.04))
    
    # Draw trend line
    mid_x = (start_x + end_x) / 2
    dip_y = start_y - (start_y - end_y) * 0.3
    
    icon_draw.line([(start_x, start_y), (mid_x, dip_y + int(icon_size * 0.1))], fill=LIGHT_BLUE, width=line_thickness)
    icon_draw.line([(mid_x, dip_y + int(icon_size * 0.1)), (end_x, end_y)], fill=LIGHT_BLUE, width=line_thickness)
    
    # Arrow head
    angle = math.atan2(end_y - (dip_y + int(icon_size * 0.1)), end_x - mid_x)
    head_size = int(icon_size * 0.08)
    head_x1 = end_x + head_size * math.cos(angle - 2.5)
    head_y1 = end_y + head_size * math.sin(angle - 2.5)
    head_x2 = end_x + head_size * math.cos(angle + 2.5)
    head_y2 = end_y + head_size * math.sin(angle + 2.5)
    icon_draw.polygon([(end_x, end_y), (head_x1, head_y1), (head_x2, head_y2)], fill=LIGHT_BLUE)
    
    # Currency symbols
    symbol_size = int(icon_size * 0.22)
    symbol_thickness = max(2, int(symbol_size * 0.14))
    draw_dollar_symbol(icon_draw, start_x + int(icon_size * 0.08), start_y - int(icon_size * 0.08), 
                      symbol_size, BRIGHT_GOLD, symbol_thickness)
    draw_rupee_symbol(icon_draw, end_x - int(icon_size * 0.05), end_y + int(icon_size * 0.1), 
                     symbol_size, BRIGHT_GOLD, symbol_thickness)
    
    # Paste icon
    img.paste(icon_img, (0, (height - icon_size) // 2), icon_img)
    
    # Draw text
    try:
        font_size = int(height * 0.35)
        font_paths = [
            '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
            '/System/Library/Fonts/Supplemental/Arial.ttf',
            '/System/Library/Fonts/Helvetica.ttc',
        ]
        font = None
        for path in font_paths:
            try:
                font = ImageFont.truetype(path, font_size)
                break
            except:
                continue
        
        if font:
            text_draw = ImageDraw.Draw(img)
            text_x = icon_size + 10
            text_y = height // 2
            text_draw.text((text_x, text_y), text, fill=WHITE, font=font, anchor='lm')
    except:
        pass
    
    img.save(output_path, 'PNG', optimize=True)
    print(f"✓ Created: {output_path} ({size[0]}x{size[1]})")

def main():
    """Generate all logo files"""
    print("🎨 Generating Simple & Elegant CashFlow Logos...")
    print("=" * 60)
    print("✨ Design Features:")
    print("   • Simple dark blue background")
    print("   • Clean chart axes (L-shape)")
    print("   • Elegant trend line with natural flow")
    print("   • Large, clear currency symbols")
    print("   • Dollar ($) → Rupee (₹) flow")
    print("=" * 60)
    
    # Create output directories
    os.makedirs('public/logos', exist_ok=True)
    os.makedirs('public/favicons', exist_ok=True)
    
    # Favicon sizes
    favicon_sizes = [16, 32, 48, 64]
    print("\n📱 Generating Favicons...")
    for size in favicon_sizes:
        create_favicon((size, size), f'public/favicons/favicon-{size}x{size}.png')
    
    # App icon sizes
    app_icon_sizes = [128, 256, 512, 1024]
    print("\n📱 Generating App Icons...")
    for size in app_icon_sizes:
        create_logo_icon((size, size), f'public/logos/icon-{size}x{size}.png')
    
    # Logo variations
    print("\n🎯 Generating Logo Variations...")
    create_logo_icon((512, 512), 'public/logos/logo-icon-512.png')
    create_logo_icon((1024, 1024), 'public/logos/logo-icon-1024.png')
    create_logo_icon((512, 512), 'public/logos/logo-icon-v2.png')
    create_logo_with_text((600, 150), 'public/logos/logo-horizontal.png')
    
    # Main favicon
    create_favicon((32, 32), 'public/favicon.ico')
    
    print("\n" + "=" * 60)
    print("✅ Logo generation complete!")
    print("\n💡 Design Summary:")
    print("  • Background: Dark blue (#0f172a)")
    print("  • Chart: Simple L-shape axes")
    print("  • Line: Light blue trend line")
    print("  • Symbols: Gold $ and ₹ (large & clear)")
    print("  • Flow: Earning Dollars → Investing in Rupees")

if __name__ == '__main__':
    main()
