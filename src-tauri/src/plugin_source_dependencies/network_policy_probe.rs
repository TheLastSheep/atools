use std::os::raw::c_int;

pub(super) fn loopback_connect_denied() -> bool {
    let socket = unsafe { libc::socket(libc::AF_INET, libc::SOCK_STREAM, 0) };
    if socket < 0 {
        return false;
    }

    let mut address: libc::sockaddr_in = unsafe { std::mem::zeroed() };
    address.sin_len = std::mem::size_of::<libc::sockaddr_in>() as u8;
    address.sin_family = libc::AF_INET as libc::sa_family_t;
    address.sin_port = 9u16.to_be();
    address.sin_addr.s_addr = u32::from_ne_bytes([127, 0, 0, 1]);
    let result = unsafe {
        libc::connect(
            socket,
            (&address as *const libc::sockaddr_in).cast(),
            std::mem::size_of::<libc::sockaddr_in>() as libc::socklen_t,
        )
    };
    let denied = connect_denied(result, std::io::Error::last_os_error().raw_os_error());
    unsafe { libc::close(socket) };
    denied
}

fn connect_denied(result: c_int, error_code: Option<c_int>) -> bool {
    result < 0 && error_code.is_some_and(|code| code == libc::EPERM || code == libc::EACCES)
}

#[cfg(test)]
mod tests {
    use super::connect_denied;

    #[test]
    fn only_permission_errors_from_connect_count_as_network_denial() {
        assert!(connect_denied(-1, Some(libc::EPERM)));
        assert!(connect_denied(-1, Some(libc::EACCES)));
        assert!(!connect_denied(-1, Some(libc::ECONNREFUSED)));
        assert!(!connect_denied(-1, Some(libc::ETIMEDOUT)));
        assert!(!connect_denied(0, None));
        assert!(!connect_denied(-1, None));
    }
}
