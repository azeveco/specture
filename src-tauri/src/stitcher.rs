use image::{RgbaImage, GenericImageView};

/// Stitches a list of vertical scrolling screenshots together.
pub fn stitch_frames(frames: Vec<RgbaImage>) -> Option<RgbaImage> {
    if frames.is_empty() {
        return None;
    }
    if frames.len() == 1 {
        return Some(frames[0].clone());
    }

    let mut final_image = frames[0].clone();
    let mut last_stitched_frame = frames[0].clone();

    for next_frame in frames.iter().skip(1) {
        println!("Stitching next frame...");
        let d = find_displacement(&last_stitched_frame, next_frame);
        println!("Found displacement: {}", d);

        if d <= 0 {
            // identical frame, user scrolled backwards, or no overlap found
            continue;
        }

        let next_h = next_frame.height();
        let d_u32 = d as u32;
        // If the displacement is somehow larger than the next frame, clamp it.
        let d_u32 = d_u32.min(next_h);

        let new_height = final_image.height() + d_u32;
        let width = final_image.width().min(next_frame.width());
        
        let mut new_final_image = RgbaImage::new(width, new_height);
        
        // Copy original
        image::imageops::overlay(&mut new_final_image, &final_image, 0, 0);
        
        // Copy the new portion (the bottom D pixels of next_frame)
        let new_part = image::imageops::crop_imm(next_frame, 0, next_h - d_u32, width, d_u32);
        image::imageops::overlay(&mut new_final_image, &new_part.to_image(), 0, final_image.height() as i64);
        
        final_image = new_final_image;
        last_stitched_frame = next_frame.clone();
    }

    Some(final_image)
}

fn find_displacement(img1: &RgbaImage, img2: &RgbaImage) -> i32 {
    let w = img1.width().min(img2.width());
    let h1 = img1.height();
    let h2 = img2.height();
    let h = h1.min(h2);
    let h_i32 = h as i32;
    
    // To handle sticky headers and footers, we only compare the middle section.
    let header_margin = 150.min(h_i32 / 4);
    let footer_margin = 150.min(h_i32 / 4);
    let w_usize = w as usize;
    let margin_x = 20.min(w_usize / 4);
    
    let mut best_diff = u64::MAX;
    let mut best_d = 0;
    
    // Check D from -h * 3 / 4 to h * 3 / 4. 
    // Positive D means content moved UP in img2 (user scrolled DOWN).
    // Negative D means content moved DOWN in img2 (user scrolled UP).
    let max_d = h_i32 * 3 / 4;
    
    // Use raw buffer access for massive performance boost
    let raw1 = img1.as_raw();
    let raw2 = img2.as_raw();
    let stride1 = (img1.width() * 4) as i32;
    let stride2 = (img2.width() * 4) as i32;

    // Helper closure to compute diff for a given d and steps
    let compute_diff = |d: i32, step_x: usize, step_y: i32| -> Option<u64> {
        let mut diff = 0u64;
        let mut count = 0;
        
        let start_y = header_margin.max(header_margin - d);
        let end_y = (h_i32 - footer_margin).min(h_i32 - footer_margin - d);
        
        let mut y = start_y;
        while y < end_y {
            let row1_idx = ((y + d) * stride1) as usize;
            let row2_idx = (y * stride2) as usize;
            
            let mut x = margin_x;
            while x < w_usize.saturating_sub(margin_x) {
                let px = x * 4;
                
                if row1_idx + px + 2 < raw1.len() && row2_idx + px + 2 < raw2.len() {
                    let r1 = raw1[row1_idx + px] as i32;
                    let g1 = raw1[row1_idx + px + 1] as i32;
                    let b1 = raw1[row1_idx + px + 2] as i32;
                    
                    let r2 = raw2[row2_idx + px] as i32;
                    let g2 = raw2[row2_idx + px + 1] as i32;
                    let b2 = raw2[row2_idx + px + 2] as i32;
                    
                    diff += (r1 - r2).abs() as u64;
                    diff += (g1 - g2).abs() as u64;
                    diff += (b1 - b2).abs() as u64;
                    count += 1;
                }
                x += step_x;
            }
            y += step_y;
        }
        
        if count > 0 {
            Some(diff / count)
        } else {
            None
        }
    };
    
    // Coarse Search
    let mut coarse_d = -max_d;
    while coarse_d <= max_d {
        if let Some(avg_diff) = compute_diff(coarse_d, 64, 32) {
            if avg_diff < best_diff {
                best_diff = avg_diff;
                best_d = coarse_d;
            }
        }
        coarse_d += 16;
    }
    
    // Fine Search
    best_diff = u64::MAX; // Reset best_diff for fine search precision
    let fine_start = (best_d - 32).max(-max_d);
    let fine_end = (best_d + 32).min(max_d);
    
    for d in fine_start..=fine_end {
        if let Some(avg_diff) = compute_diff(d, 16, 8) {
            if avg_diff < best_diff {
                best_diff = avg_diff;
                best_d = d;
            }
        }
    }
    
    best_d
}
